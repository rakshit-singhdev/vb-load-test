/**
 * A swarm of headless Virtual Buzzer players.
 *
 * Each bot does what the real player page does (client usePlayerSession.ts), at
 * the protocol level, no browser:
 *   1. its own clock sync against GET /v1/time (lowest-RTT of 5 samples), like a phone
 *   2. POST /v1/sessions/:pin/join  -> playerToken + Ably token request + channels
 *   3. Ably Realtime with that token, subscribe game:{id}:events
 *   4. on question.armed: press at a planned moment after armAt, stamp `pressedAt`
 *      with ITS synced clock, publish BuzzIn on its shard (HTTP fallback)
 *   5. Ably token renewal = rejoin with the playerToken (same seat)
 *
 * Order check: the swarm keeps one reference clock. Every press is recorded on
 * it (the "true" press moment), separately from the `pressedAt` the bot claims
 * through its own synced (and optionally skewed) clock. After each round the
 * swarm reads the server's full order from the snapshot and compares.
 *
 * No Ably API key is needed: the gameplay server mints every player's token.
 */
import * as Ably from 'ably';
import { randomUUID } from 'node:crypto';

import { formatIst } from './config.mjs';
import { analyzeRound, buildReports, stats } from './report.mjs';

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(status, code, message, retryAfterSec) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

function makeApi(baseUrl, timeoutMs) {
  return async function api(path, { method = 'GET', body, token } = {}) {
    let res;
    try {
      res = await fetch(`${baseUrl}/v1${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(0, 'network', err?.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : String(err?.cause?.code ?? err?.message ?? err));
    }
    if (method === 'HEAD') return undefined;
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      throw new ApiError(res.status, data?.error?.code ?? `http_${res.status}`, data?.error?.message ?? res.statusText, Number.isFinite(ra) ? ra : undefined);
    }
    return data;
  };
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/**
 * Server clock as one device sees it. `skewMs` simulates a phone whose own
 * clock is wrong by that much; a correct sync cancels it out.
 */
export class ServerClock {
  constructor(api, skewMs = 0) {
    this.api = api;
    this.skewMs = skewMs;
    this.offset = 0;
    this.rtt = 0;
    this.syncedAt = 0;
    this.syncs = 0;
  }

  device() {
    return Date.now() + this.skewMs;
  }

  async sync(samples = 5) {
    let best = null;
    for (let i = 0; i < samples; i++) {
      const t0 = this.device();
      const { now } = await this.api('/time');
      const t1 = this.device();
      const rtt = t1 - t0;
      if (best === null || rtt < best.rtt) best = { rtt, offset: now - (t0 + rtt / 2) };
    }
    this.offset = best.offset;
    this.rtt = Math.round(best.rtt);
    this.syncedAt = Date.now();
    this.syncs += 1;
    return best;
  }

  async syncIfOlder(maxAgeMs) {
    if (Date.now() - this.syncedAt > maxAgeMs) await this.sync();
  }

  now() {
    return this.device() + this.offset;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const rand = (min, max) => min + Math.random() * (max - min);
const suffix = () => Math.random().toString(36).slice(2, 5);
const inc = (obj, key, by = 1) => {
  obj[key] = (obj[key] ?? 0) + by;
};
function shuffled(n) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A clock re-measured more recently than this is reused, as on the phone. */
const CLOCK_MAX_AGE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

class Bot {
  constructor(index, swarm) {
    this.index = index;
    this.swarm = swarm;
    const { cfg } = swarm;
    this.name = `${cfg.namePrefix} ${String(index + 1).padStart(2, '0')}`;
    this.state = 'waiting'; // waiting | joining | joined | failed | kicked | ended | closed
    this.joined = null;
    this.playerToken = null;
    this.client = null;
    this.lastV = -1;
    this.epoch = -1;
    this.phase = null;
    this.question = null; // { questionId, attempt, armAt, endsAt, excludedTeamIds, buzzed, inOrder }
    this.buzzTimer = null;
    this.closed = false;
    /** Events that arrive while a snapshot is loading wait here, like the real client's buffer. */
    this.buffer = null;
    this.clock = cfg.clockSync === 'shared' ? swarm.ref : new ServerClock(swarm.api, cfg.clockSkewMs ? Math.round(rand(-cfg.clockSkewMs, cfg.clockSkewMs)) : 0);
  }

  get log() {
    return this.swarm.log;
  }

  // ---- join -------------------------------------------------------------

  async join(teamId) {
    const { cfg, api, m } = this.swarm;
    this.state = 'joining';
    if (this.clock !== this.swarm.ref) {
      try {
        await this.clock.sync();
      } catch (err) {
        inc(m.counts, 'clockSyncFailed');
        this.log.warn(`${this.name}: clock sync failed (${err.message}); buzzing on an unsynced clock`);
      }
    }
    let name = this.name;
    let team = teamId;
    for (let attempt = 1; attempt <= cfg.joinRetries; attempt++) {
      const t0 = Date.now();
      try {
        const res = await api(`/sessions/${cfg.pin}/join`, { method: 'POST', body: { name, ...(team ? { teamId: team } : {}), rttMs: this.clock.rtt } });
        m.joinMs.push(Date.now() - t0);
        this.name = name;
        this.joined = res;
        this.playerToken = res.playerToken;
        this.swarm.sessionId ??= res.sessionId;
        this.state = 'joined';
        inc(m.counts, 'joined');
        if (team && res.teamId === team) inc(m.counts, 'joinedExistingTeam');
        this.log.debug(`${this.name} joined: player=${res.playerId} team=${res.teamId} shard=${res.shard}`);
        return res;
      } catch (err) {
        inc(m.joinErrors, err.code ?? 'unknown');
        if (err.code === 'name_taken' || err.code === 'team_name_taken') {
          name = `${this.name}-${suffix()}`.slice(0, 40);
          continue;
        }
        if (team && (err.code === 'session_full' || err.code === 'not_found' || err.code === 'bad_request')) {
          this.log.warn(`${this.name}: team ${team} refused (${err.code}), founding own team`);
          team = undefined;
          continue;
        }
        const retryable = err.code === 'rate_limited' || err.code === 'network' || err.code === 'internal' || err.status >= 500;
        if (retryable && attempt < cfg.joinRetries) {
          const wait = err.retryAfterSec ? err.retryAfterSec * 1000 : Math.min(30000, 1000 * 2 ** attempt) + rand(0, 1000);
          this.log.warn(`${this.name}: join attempt ${attempt} failed (${err.message}); retrying in ${Math.round(wait / 1000)}s`);
          await sleep(wait);
          continue;
        }
        this.state = err.code === 'session_ended' ? 'ended' : 'failed';
        this.log.error(`${this.name}: join failed for good: ${err.message}`);
        inc(m.counts, 'joinFailed');
        throw err;
      }
    }
    this.state = 'failed';
    inc(m.counts, 'joinFailed');
    throw new Error(`${this.name}: join retries exhausted`);
  }

  /** Same seat, fresh tokens. Used for Ably token renewal and chaos reconnects. */
  async rejoin() {
    const { cfg, api, m } = this.swarm;
    const t0 = Date.now();
    try {
      const res = await api(`/sessions/${cfg.pin}/join`, { method: 'POST', token: this.playerToken, body: { name: this.name, rttMs: this.clock.rtt } });
      m.rejoinMs.push(Date.now() - t0);
      inc(m.counts, 'rejoins');
      if (res.playerId !== this.joined.playerId) inc(m.counts, 'rejoinGotNewSeat!');
      this.playerToken = res.playerToken;
      return res;
    } catch (err) {
      inc(m.rejoinErrors, err.code ?? 'unknown');
      if (err.code === 'kicked') this.markKicked();
      if (err.code === 'session_ended') this.onEnded();
      throw err;
    }
  }

  // ---- Ably -------------------------------------------------------------

  async connect() {
    const { m } = this.swarm;
    let first = true;
    const t0 = Date.now();
    const client = new Ably.Realtime({
      echoMessages: false,
      authCallback: (_params, cb) => {
        if (first) {
          first = false;
          cb(null, this.joined.ablyToken);
          return;
        }
        inc(m.counts, 'ablyTokenRenewals');
        this.rejoin().then(
          (res) => cb(null, res.ablyToken),
          (err) => cb(err?.message ?? 'rejoin failed', null)
        );
      },
    });
    this.client = client;
    client.connection.on((change) => {
      if (change.current === 'failed' || change.current === 'suspended' || (change.current === 'disconnected' && !this.closed)) {
        inc(m.ablyStates, change.current);
        if (change.current !== 'disconnected') this.log.warn(`${this.name}: Ably ${change.current} ${change.reason?.message ?? ''}`);
      }
    });

    const events = client.channels.get(this.joined.channels.events);
    events.on('attached', (change) => {
      if (change.resumed === false && this.lastV >= 0) void this.resync('reattach');
    });
    await events.subscribe((msg) => this.onMessage(msg.data));
    m.ablyConnectMs.push(Date.now() - t0);
    await this.resync('initial');
  }

  disconnect() {
    clearTimeout(this.buzzTimer);
    this.buzzTimer = null;
    if (this.client) {
      try {
        this.client.close();
      } catch {
        /* already closed */
      }
    }
    this.client = null;
  }

  async resync(why) {
    const { api, m } = this.swarm;
    if (!this.joined || this.buffer !== null) return; // one load at a time; the buffer catches the rest
    if (why !== 'initial') inc(m.resyncs, why);
    this.buffer = [];
    try {
      const snap = await api(`/sessions/${this.joined.sessionId}/snapshot`);
      this.lastV = snap.version;
      this.epoch = snap.epoch ?? 0;
      this.phase = snap.phase;
      if (snap.phase === 'ended') return this.onEnded();
      if (!snap.players.some((p) => p.id === this.joined.playerId)) return this.markKicked();
      const q = snap.currentQuestion;
      if (q) {
        this.setQuestion(q.questionId, q.attempt, q.armAt, q.endsAt, q.excludedTeamIds);
        // An arm we only learnt about from the snapshot (missed event): still press, as a phone would.
        if (snap.phase === 'armed' && q.armAt !== null && q.order === null) this.maybeScheduleBuzz(false);
        if (snap.phase === 'resolved' && q.order) this.swarm.onResolvedSeen(q.questionId, q.attempt, q.armAt);
      }
    } catch (err) {
      inc(m.counts, 'snapshotErrors');
      this.log.warn(`${this.name}: snapshot failed (${err.message})`);
    } finally {
      const pending = this.buffer ?? [];
      this.buffer = null;
      for (const e of pending) {
        if (this.buffer !== null) this.buffer.push(e); // a replayed gap started another load
        else this.handle(e);
      }
    }
  }

  setQuestion(questionId, attempt, armAt, endsAt, excludedTeamIds) {
    const q = this.question;
    if (q && q.questionId === questionId && q.attempt === attempt && q.armAt === armAt) {
      q.excludedTeamIds = excludedTeamIds;
      return;
    }
    clearTimeout(this.buzzTimer);
    this.buzzTimer = null;
    this.question = { questionId, attempt, armAt, endsAt, excludedTeamIds, buzzed: false, inOrder: false };
  }

  onMessage(e) {
    if (!e || typeof e !== 'object' || typeof e.type !== 'string') return;
    const { m } = this.swarm;
    inc(m.eventsByType, e.type);
    const now = this.swarm.ref.now();
    if (typeof e.at === 'number') m.eventDelayMs.push(Math.max(0, now - e.at));
    // Measurements only, taken on arrival: an event the version logic later drops still counts here.
    if (e.type === 'question.armed') {
      const round = this.swarm.round(e.questionId, e.attempt);
      if (round) {
        round.armAt = e.armAt;
        round.armedSeen += 1;
        // Positive = the event beat armAt (good: buttons open in sync). Negative = arrived late.
        round.armLeadMs.push(e.armAt - now);
      }
    } else if (e.type === 'buzz.resolved') this.swarm.onResolvedSeen(e.questionId, e.attempt, null, e);
    if (this.buffer !== null) {
      this.buffer.push(e);
      return;
    }
    this.handle(e);
  }

  handle(e) {
    const { m, ref } = this.swarm;

    const epoch = e.epoch ?? 0;
    if (epoch < this.epoch) return;
    if (epoch > this.epoch) {
      void this.resync('epoch');
      return;
    }
    if (typeof e.v === 'number') {
      if (e.v <= this.lastV) return;
      if (e.v > this.lastV + 1) {
        // Which event jumped the queue, and by how much: tells out-of-order delivery from a lost event.
        inc(m.gapsBy, `${e.type}(+${e.v - this.lastV - 1})`);
        void this.resync('gap');
        return;
      }
      this.lastV = e.v;
    }

    const myTeam = this.joined.teamId;
    switch (e.type) {
      case 'phase.changed':
        this.phase = e.phase;
        if (e.phase === 'ended') this.onEnded();
        // The phone re-measures its clock when a question opens (if the last sync is old).
        if (e.phase === 'question' && this.clock !== ref) void this.clock.syncIfOlder(CLOCK_MAX_AGE_MS).catch(() => {});
        break;
      case 'question.armed': {
        this.phase = 'armed';
        this.setQuestion(e.questionId, e.attempt, e.armAt, e.endsAt, e.excludedTeamIds);
        this.maybeScheduleBuzz(false);
        break;
      }
      case 'buzz.resolved': {
        this.phase = 'resolved';
        const row = e.order.find((r) => r.teamId === myTeam);
        if (this.question) this.question.inOrder = Boolean(row);
        if (this.swarm.cfg.lateBuzzProbability > 0 && !row) this.maybeScheduleBuzz(true);
        break;
      }
      case 'buzz.appended':
        if (e.row.teamId === myTeam && this.question) this.question.inOrder = true;
        break;
      case 'round.reset':
        clearTimeout(this.buzzTimer);
        this.buzzTimer = null;
        if (this.question) this.question.buzzed = false;
        this.phase = 'question';
        inc(m.roundResets, e.reason);
        break;
      case 'roster.changed':
        if (e.left?.includes(this.joined.playerId)) this.markKicked();
        break;
      case 'score.changed':
        if (e.teamId === myTeam) this.swarm.scores.set(myTeam, e.score);
        break;
      default:
        break;
    }
  }

  /**
   * Plans the press on the swarm's reference clock: that is the "human" tapping
   * in real time. The bot's own synced clock only stamps `pressedAt` and gates
   * the button, exactly as on a phone.
   */
  maybeScheduleBuzz(late) {
    const { cfg, ref, m } = this.swarm;
    const q = this.question;
    if (!q || q.buzzed || this.buzzTimer || this.state !== 'joined') return;
    if (q.excludedTeamIds?.includes(this.joined.teamId)) return;
    const round = this.swarm.round(q.questionId, q.attempt);
    if (!round) return; // past ROUNDS: sit this one out
    if (Math.random() > (late ? cfg.lateBuzzProbability : cfg.buzzProbability)) return;

    let target;
    let slot = null;
    if (late) target = ref.now() + rand(cfg.buzzMinMs, cfg.buzzMaxMs);
    else if (cfg.buzzPattern === 'staggered') {
      slot = this.swarm.slotFor(round, this.index);
      target = (q.armAt ?? ref.now()) + cfg.buzzStartMs + slot * cfg.buzzGapMs;
    } else target = (q.armAt ?? ref.now()) + rand(cfg.buzzMinMs, cfg.buzzMaxMs);

    const key = `${q.questionId}#${q.attempt}#${q.armAt}`;
    this.buzzTimer = setTimeout(() => {
      this.buzzTimer = null;
      const cur = this.question;
      if (!cur || `${cur.questionId}#${cur.attempt}#${cur.armAt}` !== key) return;
      if (!late && this.phase !== 'armed' && this.phase !== 'resolved') return;
      if (late && cur.inOrder) return;
      // Like a phone: the button stays disabled until ITS clock reaches armAt.
      if (cur.armAt !== null && this.clock.now() < cur.armAt) {
        inc(m.counts, 'pressBlockedBeforeArm(clock error)');
        return;
      }
      void this.buzz(cur, late, slot, target);
    }, Math.max(0, target - ref.now()));
  }

  async buzz(q, late, slot, plannedAt) {
    const { cfg, api, ref } = this.swarm;
    q.buzzed = true;
    const round = this.swarm.round(q.questionId, q.attempt);
    const truePressAt = ref.now();
    const payload = {
      questionId: q.questionId,
      attempt: q.attempt,
      pressedAt: Math.round(this.clock.now()),
      nonce: randomUUID(),
      rttMs: this.clock.rtt,
    };
    round.presses.set(this.joined.playerId, {
      playerId: this.joined.playerId,
      teamId: this.joined.teamId,
      name: this.name,
      slot,
      late,
      plannedAt,
      truePressAt,
      claimedPressedAt: payload.pressedAt,
      skewMs: this.clock.skewMs,
      rttMs: this.clock.rtt,
    });
    if (late) round.lateSent += 1;
    const dup = Math.random() * 100 < cfg.duplicateBuzzPct;

    const viaAbly = async () => {
      const t0 = Date.now();
      const ch = this.client?.channels.get(this.joined.channels.buzz);
      if (!ch) throw new Error('no Ably client');
      await Promise.race([ch.publish('buzz', payload), sleep(4000).then(() => Promise.reject(new Error('publish timeout')))]);
      this.swarm.m.ablyPublishMs.push(Date.now() - t0);
      inc(round.outcomes, 'ably:published');
    };
    const viaHttp = async () => {
      const t0 = Date.now();
      try {
        const ack = await api(`/sessions/${this.joined.sessionId}/buzz`, { method: 'POST', token: this.playerToken, body: payload });
        this.swarm.m.httpBuzzMs.push(Date.now() - t0);
        inc(round.outcomes, ack.accepted ? 'http:accepted' : `http:${ack.reason ?? 'rejected'}`);
      } catch (err) {
        inc(round.outcomes, `http:error:${err.code}`);
        throw err;
      }
    };

    try {
      if (cfg.buzzTransport === 'http') {
        await viaHttp();
        if (dup) await viaHttp();
      } else if (cfg.buzzTransport === 'both') {
        await Promise.allSettled([viaAbly(), viaHttp()]);
      } else {
        try {
          await viaAbly();
          if (dup) await viaAbly();
        } catch (err) {
          inc(round.outcomes, 'ably:failed->http');
          this.log.warn(`${this.name}: Ably buzz failed (${err.message}), falling back to HTTP`);
          await viaHttp();
        }
      }
    } catch (err) {
      inc(round.outcomes, 'lost');
      this.log.error(`${this.name}: buzz lost (${err.message})`);
    }
  }

  markKicked() {
    if (this.state === 'kicked') return;
    this.state = 'kicked';
    inc(this.swarm.m.counts, 'kicked');
    this.log.warn(`${this.name} was removed by the host`);
    this.disconnect();
    this.swarm.checkDone();
  }

  onEnded() {
    if (this.state === 'ended') return;
    if (this.state === 'joined') this.state = 'ended';
    this.disconnect();
    this.swarm.checkDone();
  }

  close() {
    this.closed = true;
    if (this.state === 'joined') this.state = 'closed';
    this.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Swarm
// ---------------------------------------------------------------------------

export class Swarm {
  /**
   * @param cfg   from loadConfig()
   * @param log   { info, warn, error } — each takes a string
   */
  constructor(cfg, log) {
    this.cfg = cfg;
    const quiet = () => {};
    this.log = { ...log, debug: cfg.verbose ? log.info : quiet };
    this.api = makeApi(cfg.backendUrl, cfg.requestTimeoutMs);
    /** Reference clock: one careful sync for the whole machine. "True" press times are taken on it. */
    this.ref = new ServerClock(this.api, 0);
    this.sessionId = null;
    this.bots = [];
    this.rounds = new Map(); // `${questionId}#${attempt}` -> round record
    this.roundIds = []; // distinct questionIds in play order
    this.scores = new Map();
    this.status = 'scheduled'; // scheduled | joining | running | finished | stopped | error
    this.finishReason = null;
    this.error = null;
    this.mode = null;
    this.timers = [];
    this.finishTimer = null;
    this.lastReport = null;
    this.m = {
      counts: {},
      joinErrors: {},
      rejoinErrors: {},
      ablyStates: {},
      eventsByType: {},
      resyncs: {},
      gapsBy: {},
      roundResets: {},
      joinMs: [],
      rejoinMs: [],
      ablyConnectMs: [],
      eventDelayMs: [],
      ablyPublishMs: [],
      httpBuzzMs: [],
    };
    this.donePromise = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /**
   * The record for one round attempt, or null when it is past ROUNDS (bots sit
   * that one out). A second chance (attempt 2+) of a counted round still counts.
   */
  round(questionId, attempt) {
    const key = `${questionId}#${attempt}`;
    let r = this.rounds.get(key);
    if (r) return r;
    if (!this.roundIds.includes(questionId)) {
      if (this.cfg.rounds > 0 && this.roundIds.length >= this.cfg.rounds) return null;
      this.roundIds.push(questionId);
    }
    r = {
      key,
      questionId,
      attempt,
      roundNo: this.roundIds.indexOf(questionId) + 1,
      armAt: null,
      armedSeen: 0,
      armLeadMs: [],
      lateSent: 0,
      outcomes: {},
      presses: new Map(),
      slots: null,
      resolvedSeen: 0,
      resolvedEvent: null,
      finalOrder: null,
      orderSource: null,
      winnerTeamId: null,
      settled: false,
      polling: false,
    };
    this.rounds.set(key, r);
    return r;
  }

  /** Staggered pattern: a fresh random press order for every round, one slot per bot. */
  slotFor(round, botIndex) {
    if (!round.slots) round.slots = shuffled(this.bots.length);
    return round.slots.indexOf(botIndex);
  }

  /** Called by every bot that sees the round resolve; the first one starts reading the full order. */
  onResolvedSeen(questionId, attempt, armAt, event) {
    const r = this.rounds.get(`${questionId}#${attempt}`);
    if (!r) return;
    if (armAt && !r.armAt) r.armAt = armAt;
    if (event) {
      r.resolvedSeen += 1;
      r.resolvedEvent ??= { at: event.at, totalBuzzed: event.totalBuzzed, winnerTeamId: event.winnerTeamId, seed: event.seed, top: event.order.length };
    }
    if (!r.polling && !r.settled) void this.pollOrder(r);
  }

  /**
   * `buzz.resolved` carries the top 20 only; the snapshot has the full order,
   * including late buzzes appended after the window. Poll until it stops growing.
   */
  async pollOrder(r) {
    r.polling = true;
    const deadline = Date.now() + 20000;
    let lastLen = -1;
    let stable = 0;
    while (Date.now() < deadline && this.status === 'running') {
      try {
        const snap = await this.api(`/sessions/${this.sessionId}/snapshot`);
        const q = snap.currentQuestion;
        if (!q || q.questionId !== r.questionId || q.attempt !== r.attempt) break; // host moved on
        if (q.order) {
          r.finalOrder = q.order;
          r.orderSource = 'snapshot';
          r.winnerTeamId = q.wonByTeamId ?? r.winnerTeamId;
          r.armAt ??= q.armAt;
          stable = q.order.length === lastLen ? stable + 1 : 0;
          lastLen = q.order.length;
          // Every bot that pressed is ranked, and nothing changed for 2 polls: settled.
          if (stable >= 2 && q.order.length >= r.presses.size) break;
        }
      } catch (err) {
        this.log.warn(`order poll failed (${err.message})`);
      }
      await sleep(1000);
    }
    r.polling = false;
    r.settled = true;
    this.onRoundSettled(r);
  }

  onRoundSettled(r) {
    const a = analyzeRound(r, this);
    this.log.info(
      `Round ${r.roundNo}${r.attempt > 1 ? ` (attempt ${r.attempt})` : ''} [${r.questionId}] settled: ` +
        `${a.pressed} pressed, ${a.ranked} ranked${a.missing.length ? `, ${a.missing.length} MISSING` : ''}; ` +
        `order ${a.preserved ? 'PRESERVED' : 'NOT preserved'} (${a.realInversions} real / ${a.tieInversions} tie-window inversions), ` +
        `first place ${a.firstOk ? 'correct' : 'WRONG'}`
    );
    const total = this.cfg.rounds;
    if (total > 0 && this.roundIds.length >= total && r.questionId === this.roundIds[total - 1] && !this.finishTimer) {
      this.log.info(`All ${total} rounds played. Finishing in ${this.cfg.roundGraceSec}s (a second chance on the last round still counts).`);
      this.finishTimer = setTimeout(() => this.stop('finished', `${total} rounds played`), this.cfg.roundGraceSec * 1000);
    }
  }

  /** Waits for START_AT, joins everyone, plays until ROUNDS are done, the game ends, STAY_MIN passes or stop(). */
  async run() {
    const { cfg, log } = this;
    try {
      const wait = cfg.startAt - Date.now();
      if (wait > 0) {
        log.info(`Waiting ${Math.round(wait / 1000)}s until ${formatIst(cfg.startAt)} to start ${cfg.players} players on pin ${cfg.pin}`);
        await this.sleepUnlessStopped(wait);
        if (this.status === 'stopped') return this.finish();
      }

      this.status = 'joining';
      const { offset, rtt } = await this.ref.sync(9);
      log.info(`Reference clock synced with ${cfg.backendUrl}: offset ${Math.round(offset)}ms, rtt ${Math.round(rtt)}ms (true press times are measured on this)`);
      this.timers.push(setInterval(() => void this.ref.sync(9).catch(() => {}), 5 * 60_000));

      const teams = await this.api(`/sessions/${cfg.pin}/teams`);
      this.mode = teams.mode;
      log.info(`Game mode: ${teams.mode}; ${teams.teams.length} team(s) already present`);
      log.info(
        `Plan: ${cfg.rounds > 0 ? `${cfg.rounds} rounds` : 'rounds until the game ends'}, pattern ${cfg.buzzPattern}` +
          (cfg.buzzPattern === 'staggered' ? ` (armAt+${cfg.buzzStartMs}ms, one press every ${cfg.buzzGapMs}ms, shuffled each round)` : ` (${cfg.buzzMinMs}-${cfg.buzzMaxMs}ms after armAt)`) +
          `, clock ${cfg.clockSync}${cfg.clockSkewMs ? ` with device skew up to ±${cfg.clockSkewMs}ms` : ''}`
      );
      if (cfg.buzzPattern === 'staggered' && cfg.buzzGapMs <= 15) log.warn(`BUZZ_GAP_MS ${cfg.buzzGapMs} is inside the server's 15ms tie window: those presses are shuffled by design`);
      if (this.mode === 'team' && cfg.teamSize > 1) log.warn('Team game with TEAM_SIZE > 1: the server ranks one row per team (its fastest player), so the order check is per team');

      this.bots = Array.from({ length: cfg.players }, (_, i) => new Bot(i, this));
      const step = cfg.players > 1 ? (cfg.joinSpreadSec * 1000) / (cfg.players - 1) : 0;
      const t0 = Date.now();
      const founders = new Map(); // team slot -> Promise<teamId | undefined>

      const joins = this.bots.map(async (bot, i) => {
        await sleep(t0 + i * step - Date.now());
        if (this.status === 'stopped') return;
        let teamId;
        const slot = Math.floor(i / cfg.teamSize);
        const isFounder = i % cfg.teamSize === 0;
        if (this.mode === 'team' && cfg.teamSize > 1 && !isFounder) teamId = await founders.get(slot);
        const p = bot.join(teamId).then(
          (res) => res.teamId,
          () => undefined
        );
        if (isFounder) founders.set(slot, p);
        if ((await p) === undefined || this.status === 'stopped') return;
        try {
          await bot.connect();
        } catch (err) {
          inc(this.m.counts, 'ablyConnectFailed');
          log.error(`${bot.name}: Ably connect failed (${err.message})`);
        }
      });
      await Promise.all(joins);
      if (this.status === 'stopped') return this.finish();

      this.status = 'running';
      log.info(`Joined ${this.m.counts.joined ?? 0}/${cfg.players} in ${((Date.now() - t0) / 1000).toFixed(1)}s. Join latency ${stats(this.m.joinMs)}`);
      log.info(cfg.rounds > 0 ? `Ready. Start round 1 of ${cfg.rounds} from the host screen.` : 'Ready. Play rounds from the host screen; end the game to get the report.');
      this.checkDone();

      this.timers.push(setInterval(() => log.info(this.progressLine()), cfg.reportEverySec * 1000));
      if (cfg.chaosDropPct > 0) this.timers.push(setInterval(() => void this.chaos(), cfg.chaosIntervalSec * 1000));
      this.timers.push(setTimeout(() => this.stop('finished', `STAY_MIN (${cfg.stayMin} min) reached`), cfg.stayMin * 60_000));

      await this.donePromise;
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      log.error(`Run failed: ${err.message}`);
    }
    return this.finish();
  }

  async sleepUnlessStopped(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && this.status !== 'stopped') await sleep(Math.min(5000, end - Date.now()));
  }

  async chaos() {
    const live = this.bots.filter((b) => b.state === 'joined' && b.client);
    const n = Math.max(1, Math.round((live.length * this.cfg.chaosDropPct) / 100));
    const victims = shuffled(live.length)
      .slice(0, n)
      .map((i) => live[i]);
    this.log.info(`Chaos: dropping ${victims.length} connection(s) for ${this.cfg.chaosDownSec}s`);
    await Promise.all(
      victims.map(async (bot) => {
        inc(this.m.counts, 'chaosDrops');
        bot.disconnect();
        await sleep(this.cfg.chaosDownSec * 1000);
        if (bot.state !== 'joined' || this.status !== 'running') return;
        try {
          const res = await bot.rejoin();
          bot.joined = { ...bot.joined, ablyToken: res.ablyToken, channels: res.channels };
          await bot.connect();
        } catch (err) {
          inc(this.m.counts, 'chaosReconnectFailed');
          this.log.error(`${bot.name}: chaos reconnect failed (${err.message})`);
        }
      })
    );
  }

  checkDone() {
    if (this.status !== 'running') return;
    if (this.bots.length > 0 && this.bots.every((b) => b.state !== 'joined' && b.state !== 'joining' && b.state !== 'waiting')) {
      const ended = this.bots.some((b) => b.state === 'ended');
      this.stop('finished', ended ? 'host ended the game' : 'no bots left in the game');
    }
  }

  stop(status = 'stopped', reason = status) {
    if (this.status === 'finished' || this.status === 'stopped') return;
    this.status = status;
    this.finishReason = reason;
    this.log.info(`Stopping: ${reason}`);
    this.resolveDone();
  }

  finish() {
    for (const t of this.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    clearTimeout(this.finishTimer);
    this.timers = [];
    for (const b of this.bots) b.close();
    if (this.status !== 'error' && this.status !== 'stopped') this.status = 'finished';
    const { text, json } = buildReports(this);
    this.log.info(text);
    this.lastReport = json;
    return json;
  }

  progressLine() {
    const by = {};
    for (const b of this.bots) inc(by, b.state);
    const connected = this.bots.filter((b) => b.client?.connection.state === 'connected').length;
    const last = [...this.rounds.values()].at(-1);
    return (
      `[progress] bots ${JSON.stringify(by)} ablyConnected=${connected} rounds=${this.roundIds.length}${this.cfg.rounds ? `/${this.cfg.rounds}` : ''}` +
      (last ? ` last=round ${last.roundNo} pressed=${last.presses.size} ranked=${last.finalOrder?.length ?? '-'}` : '')
    );
  }

  report() {
    return this.lastReport ?? buildReports(this).json;
  }
}

// Run by mistake (`node lib/...` or an editor's "Run file")? This module only defines code; say so instead of exiting silently.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  console.error('This file is a library and does nothing on its own.\nRun the swarm with:  npm run cli   (or: node cli.mjs --help)\nRender service:     npm start');
  process.exitCode = 1;
}
