/**
 * A swarm of headless Virtual Buzzer players.
 *
 * Each bot does exactly what the real player page does (see
 * client/src/pages/Games/VirtualBuzzer/api/usePlayerSession.ts), at the protocol
 * level, no browser:
 *   1. clock sync against GET /v1/time (lowest-RTT of 5 samples)
 *   2. POST /v1/sessions/:pin/join  -> playerToken + Ably token request + channels
 *   3. Ably Realtime with that token, subscribe game:{id}:events
 *   4. on question.armed: wait until armAt (server clock) + a human reaction time,
 *      publish BuzzIn on its shard; fall back to POST /buzz if Ably fails
 *   5. Ably token renewal = rejoin with the playerToken (same seat)
 *
 * No Ably API key is needed: the gameplay server mints every player's token.
 */
import * as Ably from 'ably';
import { randomUUID } from 'node:crypto';

import { formatIst } from './config.mjs';

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
// Clock (one per process: every bot runs on the same machine)
// ---------------------------------------------------------------------------

class ServerClock {
  constructor(api) {
    this.api = api;
    this.offset = 0;
    this.rtt = 0;
    this.syncedAt = 0;
  }

  async sync(samples = 5) {
    let best = null;
    for (let i = 0; i < samples; i++) {
      const t0 = Date.now();
      const { now } = await this.api('/time');
      const t1 = Date.now();
      const rtt = t1 - t0;
      if (best === null || rtt < best.rtt) best = { rtt, offset: now - (t0 + rtt / 2) };
    }
    this.offset = best.offset;
    this.rtt = Math.round(best.rtt);
    this.syncedAt = Date.now();
    return best;
  }

  now() {
    return Date.now() + this.offset;
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function pct(values, p) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}
function stats(values) {
  if (values.length === 0) return 'n/a';
  return `n=${values.length} p50=${pct(values, 50)}ms p95=${pct(values, 95)}ms max=${Math.round(Math.max(...values))}ms`;
}
const inc = (obj, key, by = 1) => {
  obj[key] = (obj[key] ?? 0) + by;
};

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const rand = (min, max) => min + Math.random() * (max - min);
const suffix = () => Math.random().toString(36).slice(2, 5);

class Bot {
  constructor(index, swarm) {
    this.index = index;
    this.swarm = swarm;
    this.name = `${swarm.cfg.namePrefix} ${String(index + 1).padStart(2, '0')}`;
    this.state = 'waiting'; // waiting | joining | joined | failed | kicked | ended | closed
    this.joined = null; // JoinResponse
    this.playerToken = null;
    this.client = null;
    this.lastV = -1;
    this.epoch = -1;
    this.phase = null;
    this.question = null; // { questionId, attempt, armAt, endsAt, excludedTeamIds, buzzed, inOrder, won }
    this.buzzTimer = null;
    this.closed = false;
    /** Events that arrive while a snapshot is loading wait here, like the real client's buffer. */
    this.buffer = null;
  }

  get log() {
    return this.swarm.log;
  }

  // ---- join -------------------------------------------------------------

  async join(teamId) {
    const { cfg, api, clock, m } = this.swarm;
    this.state = 'joining';
    let name = this.name;
    let team = teamId;
    for (let attempt = 1; attempt <= cfg.joinRetries; attempt++) {
      const t0 = Date.now();
      try {
        const res = await api(`/sessions/${cfg.pin}/join`, { method: 'POST', body: { name, ...(team ? { teamId: team } : {}), rttMs: clock.rtt } });
        m.joinMs.push(Date.now() - t0);
        this.name = name;
        this.joined = res;
        this.playerToken = res.playerToken;
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
        if (team && (err.code === 'session_full' || err.code === 'not_found')) {
          // The team filled up or vanished: found a new one instead, as a phone would.
          this.log.warn(`${this.name}: team ${team} refused (${err.code}), founding own team`);
          team = undefined;
          continue;
        }
        if (err.code === 'bad_request' && team) {
          team = undefined; // solo game: teamId is a 400
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
    const { cfg, api, clock, m } = this.swarm;
    const t0 = Date.now();
    try {
      const res = await api(`/sessions/${cfg.pin}/join`, { method: 'POST', token: this.playerToken, body: { name: this.name, rttMs: clock.rtt } });
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

  async connect({ useInitialToken = true } = {}) {
    const { m } = this.swarm;
    let first = useInitialToken;
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
    // Snapshot after subscribing so nothing slips between attach and load.
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
        if (snap.phase === 'armed' && q.armAt !== null && q.order === null) this.maybeScheduleBuzz(false);
      }
    } catch (err) {
      inc(m.counts, 'snapshotErrors');
      this.log.warn(`${this.name}: snapshot failed (${err.message})`);
    } finally {
      const pending = this.buffer ?? [];
      this.buffer = null;
      // Replay what arrived meanwhile; anything the snapshot already covers is dropped by version.
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
    const { m, clock } = this.swarm;
    inc(m.eventsByType, e.type);
    if (typeof e.at === 'number') m.eventDelayMs.push(Math.max(0, clock.now() - e.at));
    if (this.buffer !== null) {
      this.buffer.push(e);
      return;
    }
    this.handle(e);
  }

  handle(e) {
    const { m, clock } = this.swarm;
    const now = clock.now();

    // Version / epoch bookkeeping, as the real client does.
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
        break;
      case 'question.armed': {
        this.phase = 'armed';
        this.setQuestion(e.questionId, e.attempt, e.armAt, e.endsAt, e.excludedTeamIds);
        const round = this.swarm.round(e.questionId, e.attempt);
        round.armAt = e.armAt;
        round.armedSeen += 1;
        // Positive = the event beat armAt (good: buttons open in sync). Negative = arrived late.
        round.armLeadMs.push(e.armAt - now);
        this.maybeScheduleBuzz(false);
        break;
      }
      case 'buzz.resolved': {
        this.phase = 'resolved';
        const round = this.swarm.round(e.questionId, e.attempt);
        round.resolvedSeen += 1;
        round.totalBuzzed = Math.max(round.totalBuzzed, e.totalBuzzed);
        round.winnerTeamId = e.winnerTeamId;
        if (round.armAt) round.resolveAfterArmMs = e.at - round.armAt;
        const row = e.order.find((r) => r.teamId === myTeam);
        if (this.question) this.question.inOrder = Boolean(row);
        if (row && row.playerId === this.joined.playerId) round.myRanks.set(this.joined.playerId, row.rank);
        if (this.question?.buzzed && !row && e.order.length < e.totalBuzzed) inc(m.counts, 'buzzedButBeyondTop20');
        if (this.swarm.cfg.lateBuzzProbability > 0 && !row) this.maybeScheduleBuzz(true);
        break;
      }
      case 'buzz.appended': {
        const round = this.swarm.round(e.questionId, e.attempt);
        round.appended += e.row.playerId === this.joined.playerId ? 1 : 0;
        if (e.row.teamId === myTeam && this.question) this.question.inOrder = true;
        break;
      }
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

  maybeScheduleBuzz(late) {
    const { cfg, clock, m } = this.swarm;
    const q = this.question;
    if (!q || q.buzzed || this.buzzTimer || this.state !== 'joined') return;
    if (q.excludedTeamIds?.includes(this.joined.teamId)) return;
    if (Math.random() > (late ? cfg.lateBuzzProbability : cfg.buzzProbability)) return;
    const reaction = rand(cfg.buzzMinMs, cfg.buzzMaxMs);
    const pressAt = late ? clock.now() + reaction : (q.armAt ?? clock.now()) + reaction;
    const key = `${q.questionId}#${q.attempt}#${q.armAt}`;
    this.buzzTimer = setTimeout(() => {
      this.buzzTimer = null;
      const cur = this.question;
      if (!cur || `${cur.questionId}#${cur.attempt}#${cur.armAt}` !== key) return;
      if (!late && this.phase !== 'armed' && this.phase !== 'resolved') return;
      if (late && cur.inOrder) return;
      // Like a phone: never tap before armAt on the synced clock.
      if (cur.armAt !== null && clock.now() < cur.armAt) {
        inc(m.counts, 'wouldHaveBeenPremature');
        return;
      }
      void this.buzz(cur, late);
    }, Math.max(0, pressAt - clock.now()));
  }

  async buzz(q, late) {
    const { cfg, api, clock, m } = this.swarm;
    q.buzzed = true;
    const round = this.swarm.round(q.questionId, q.attempt);
    round.sent += 1;
    if (late) round.lateSent += 1;
    const payload = {
      questionId: q.questionId,
      attempt: q.attempt,
      pressedAt: Math.round(clock.now()),
      nonce: randomUUID(),
      rttMs: clock.rtt,
    };
    const dup = Math.random() * 100 < cfg.duplicateBuzzPct;

    const viaAbly = async () => {
      const t0 = Date.now();
      const ch = this.client?.channels.get(this.joined.channels.buzz);
      if (!ch) throw new Error('no Ably client');
      await Promise.race([ch.publish('buzz', payload), sleep(4000).then(() => Promise.reject(new Error('publish timeout')))]);
      m.ablyPublishMs.push(Date.now() - t0);
      inc(round.outcomes, 'ably:published');
    };
    const viaHttp = async () => {
      const t0 = Date.now();
      try {
        const ack = await api(`/sessions/${this.joined.sessionId}/buzz`, { method: 'POST', token: this.playerToken, body: payload });
        m.httpBuzzMs.push(Date.now() - t0);
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
   * @param log   { info, warn, error, debug } — each takes a string
   */
  constructor(cfg, log) {
    this.cfg = cfg;
    const quiet = () => {};
    this.log = { ...log, debug: cfg.verbose ? log.info : quiet };
    this.api = makeApi(cfg.backendUrl, cfg.requestTimeoutMs);
    this.clock = new ServerClock(this.api);
    this.bots = [];
    this.rounds = new Map();
    this.scores = new Map();
    this.status = 'scheduled'; // scheduled | joining | running | finished | stopped | error
    this.error = null;
    this.mode = null;
    this.timers = [];
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

  round(questionId, attempt) {
    const key = `${questionId}#${attempt}`;
    let r = this.rounds.get(key);
    if (!r) {
      r = { key, armAt: null, armedSeen: 0, armLeadMs: [], sent: 0, lateSent: 0, outcomes: {}, resolvedSeen: 0, totalBuzzed: 0, winnerTeamId: null, resolveAfterArmMs: null, appended: 0, myRanks: new Map() };
      this.rounds.set(key, r);
    }
    return r;
  }

  /** Waits for START_AT, joins everyone, plays until the game ends, STAY_MIN passes or stop() is called. */
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
      const { offset, rtt } = await this.clock.sync();
      log.info(`Clock synced with ${cfg.backendUrl}: offset ${Math.round(offset)}ms, rtt ${Math.round(rtt)}ms`);
      this.timers.push(setInterval(() => void this.clock.sync().catch(() => {}), 5 * 60_000));

      const teams = await this.api(`/sessions/${cfg.pin}/teams`);
      this.mode = teams.mode;
      log.info(`Game mode: ${teams.mode}; ${teams.teams.length} team(s) already present`);

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
      // Founders must be registered before a member awaits them; slot promises are set synchronously after each join() call above.
      await Promise.all(joins);
      if (this.status === 'stopped') return this.finish();

      this.status = 'running';
      log.info(`Joined ${this.m.counts.joined ?? 0}/${cfg.players} in ${((Date.now() - t0) / 1000).toFixed(1)}s. Join latency ${stats(this.m.joinMs)}`);
      this.checkDone();

      this.timers.push(setInterval(() => log.info(this.progressLine()), cfg.reportEverySec * 1000));
      if (cfg.chaosDropPct > 0) this.timers.push(setInterval(() => void this.chaos(), cfg.chaosIntervalSec * 1000));
      this.timers.push(
        setTimeout(() => {
          log.info(`STAY_MIN (${cfg.stayMin} min) reached, leaving`);
          this.stop('finished');
        }, cfg.stayMin * 60_000)
      );

      await this.donePromise;
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      log.error(`Run failed: ${err.message}`);
    }
    return this.finish();
  }

  async sleepUnlessStopped(ms) {
    // Chunked so stop() is honoured and a long wait survives timer limits (> 24.8 days).
    const end = Date.now() + ms;
    while (Date.now() < end && this.status !== 'stopped') await sleep(Math.min(5000, end - Date.now()));
  }

  async chaos() {
    const live = this.bots.filter((b) => b.state === 'joined' && b.client);
    const n = Math.max(1, Math.round((live.length * this.cfg.chaosDropPct) / 100));
    const victims = live.sort(() => Math.random() - 0.5).slice(0, n);
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
      this.log.info(ended ? 'Host ended the game' : 'No bots left in the game');
      this.stop('finished');
    }
  }

  stop(status = 'stopped') {
    if (this.status === 'finished' || this.status === 'stopped') return;
    this.status = status;
    this.resolveDone();
  }

  finish() {
    for (const t of this.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    this.timers = [];
    for (const b of this.bots) b.close();
    if (this.status !== 'error' && this.status !== 'stopped') this.status = 'finished';
    const report = this.reportText();
    this.log.info(report);
    return this.report();
  }

  progressLine() {
    const by = {};
    for (const b of this.bots) inc(by, b.state);
    const connected = this.bots.filter((b) => b.client?.connection.state === 'connected').length;
    const lastRound = [...this.rounds.values()].at(-1);
    return `[progress] bots ${JSON.stringify(by)} ablyConnected=${connected} rounds=${this.rounds.size}` + (lastRound ? ` last=${lastRound.key} sent=${lastRound.sent} totalBuzzed=${lastRound.totalBuzzed}` : '');
  }

  report() {
    const by = {};
    for (const b of this.bots) inc(by, b.state);
    const ourTeams = new Set(this.bots.map((b) => b.joined?.teamId).filter(Boolean));
    return {
      status: this.status,
      error: this.error,
      mode: this.mode,
      bots: by,
      counts: this.m.counts,
      joinErrors: this.m.joinErrors,
      rejoinErrors: this.m.rejoinErrors,
      ablyStates: this.m.ablyStates,
      eventsByType: this.m.eventsByType,
      resyncs: this.m.resyncs,
      gapsBy: this.m.gapsBy,
      roundResets: this.m.roundResets,
      latency: {
        join: stats(this.m.joinMs),
        rejoin: stats(this.m.rejoinMs),
        ablyConnect: stats(this.m.ablyConnectMs),
        eventDelivery: stats(this.m.eventDelayMs),
        ablyBuzzPublish: stats(this.m.ablyPublishMs),
        httpBuzz: stats(this.m.httpBuzzMs),
      },
      rounds: [...this.rounds.values()].map((r) => ({
        round: r.key,
        armedSeenBy: r.armedSeen,
        armLead: stats(r.armLeadMs),
        buzzesSent: r.sent,
        lateBuzzesSent: r.lateSent,
        outcomes: r.outcomes,
        resolvedSeenBy: r.resolvedSeen,
        serverTotalBuzzed: r.totalBuzzed,
        resolvedAfterArmMs: r.resolveAfterArmMs,
        winnerIsBot: r.winnerTeamId ? ourTeams.has(r.winnerTeamId) : null,
        botsAppendedLate: r.appended,
      })),
      teamScores: Object.fromEntries(this.scores),
    };
  }

  reportText() {
    const r = this.report();
    const lines = [
      '================ VIRTUAL BUZZER SWARM REPORT ================',
      `status=${r.status}${r.error ? ` error=${r.error}` : ''} mode=${r.mode} bots=${JSON.stringify(r.bots)}`,
      `counts         ${JSON.stringify(r.counts)}`,
      `join errors    ${JSON.stringify(r.joinErrors)}   rejoin errors ${JSON.stringify(r.rejoinErrors)}`,
      `ably states    ${JSON.stringify(r.ablyStates)}   resyncs ${JSON.stringify(r.resyncs)}   round resets ${JSON.stringify(r.roundResets)}`,
      `events         ${JSON.stringify(r.eventsByType)}`,
      `version gaps   ${JSON.stringify(r.gapsBy)}  (event that arrived early (+missing count). Each gap = 1 snapshot fetch per phone)`,
      ...Object.entries(r.latency).map(([k, v]) => `latency ${k.padEnd(16)} ${v}`),
      'rounds:',
      ...r.rounds.map(
        (x) =>
          `  ${x.round.padEnd(8)} armedSeenBy=${x.armedSeenBy} armLead(${x.armLead}) sent=${x.buzzesSent}${x.lateBuzzesSent ? ` late=${x.lateBuzzesSent}` : ''} ` +
          `serverTotalBuzzed=${x.serverTotalBuzzed} resolvedSeenBy=${x.resolvedSeenBy} resolvedAfterArm=${x.resolvedAfterArmMs ?? '-'}ms winnerIsBot=${x.winnerIsBot} outcomes=${JSON.stringify(x.outcomes)}`
      ),
      '=============================================================',
    ];
    return lines.join('\n');
  }
}
