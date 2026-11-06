/**
 * Settings for a swarm run. Every value can come from an environment variable;
 * the CLI lets flags override them. Defaults are chosen for "~40 phones in one room".
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** `Date` in IST as `06-11-2026 18:30:00`. */
export function formatIst(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} IST`;
}

/**
 * Parses a start time given in IST as `dd mm hh mm ss` (day, month, hour 0-23,
 * minute, second). Any separators work: `06 11 18 30 00`, `06-11 18:30:00`,
 * `06/11/18/30/00`. The year is the current IST year. `now` starts immediately.
 * Returns epoch milliseconds.
 */
export function parseIstStart(input, nowMs = Date.now()) {
  const raw = String(input ?? '').trim();
  if (raw === '' || raw.toLowerCase() === 'now') return nowMs;
  const parts = raw.match(/\d+/g)?.map(Number) ?? [];
  if (parts.length !== 5) {
    throw new Error(`START_AT "${raw}" must be 5 numbers in IST: dd mm hh mm ss (e.g. "06 11 18 30 00"), or "now"`);
  }
  const [dd, mo, hh, mi, ss] = parts;
  if (dd < 1 || dd > 31 || mo < 1 || mo > 12 || hh > 23 || mi > 59 || ss > 59) {
    throw new Error(`START_AT "${raw}" is out of range (dd 1-31, mm 1-12, hh 0-23, mm 0-59, ss 0-59)`);
  }
  const year = new Date(nowMs + IST_OFFSET_MS).getUTCFullYear();
  const ms = Date.UTC(year, mo - 1, dd, hh, mi, ss) - IST_OFFSET_MS;
  // Date.UTC rolls 31-02 into March; refuse it instead of starting on the wrong day.
  if (new Date(ms + IST_OFFSET_MS).getUTCDate() !== dd) throw new Error(`START_AT "${raw}": day ${dd} does not exist in month ${mo}`);
  return ms;
}

const num = (v, def) => {
  if (v === undefined || v === null || String(v).trim() === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${v}" is not a number`);
  return n;
};

/** Builds the run config from an env-like object (process.env, or env merged with CLI flags). */
export function loadConfig(env) {
  const backendUrl = String(env.BACKEND_URL ?? '').trim().replace(/\/+$/, '');
  const pin = String(env.PIN ?? '').trim();
  if (!/^https?:\/\//.test(backendUrl)) throw new Error('BACKEND_URL is required, e.g. https://buzzer.awspf.com');
  if (!/^\d{4}$/.test(pin)) throw new Error('PIN is required: the 4-digit game pin shown on the host screen');

  const cfg = {
    backendUrl,
    pin,
    startAtRaw: String(env.START_AT ?? 'now'),
    startAt: parseIstStart(env.START_AT),
    players: num(env.PLAYERS, 40),
    /** Joins are spread evenly across this window. 0 = all at once (burst). */
    joinSpreadSec: num(env.JOIN_SPREAD_SEC, 20),
    /** Team games only. 1 = every bot founds its own team; 4 = teams of 4 (1 founder + 3 joiners). */
    teamSize: num(env.TEAM_SIZE, 1),
    namePrefix: String(env.NAME_PREFIX ?? 'Bot').slice(0, 30),
    /** Rounds to play, then leave and print the reports. 0 = until the host ends the game. */
    rounds: num(env.ROUNDS, 6),
    /** After the last round's order settles, wait this long (a second chance still counts), then finish. */
    roundGraceSec: num(env.ROUND_GRACE_SEC, 5),
    /** Chance a bot buzzes on a given armed round. */
    buzzProbability: num(env.BUZZ_PROBABILITY, 1),
    /**
     * staggered = every round the bots are shuffled and press one after another,
     *             BUZZ_GAP_MS apart from armAt + BUZZ_START_MS: the true order is known exactly.
     * random    = each bot presses at a random reaction time in [BUZZ_MIN_MS, BUZZ_MAX_MS].
     */
    buzzPattern: String(env.BUZZ_PATTERN ?? 'staggered').toLowerCase(),
    buzzStartMs: num(env.BUZZ_START_MS, 200),
    buzzGapMs: num(env.BUZZ_GAP_MS, 30),
    /** per-bot = each bot syncs its own clock like a phone; shared = one sync for the whole machine. */
    clockSync: String(env.CLOCK_SYNC ?? 'per-bot').toLowerCase(),
    /** per-bot only: each bot's device clock is off by a random amount up to ±this (ms) before syncing. */
    clockSkewMs: num(env.CLOCK_SKEW_MS, 0),
    /** Per-round detail table in the final report: full | diff (only rows out of place) | off. */
    orderTable: String(env.ORDER_TABLE ?? 'full').toLowerCase(),
    /** Reaction time after armAt, uniform in [min, max] (pattern random, and late buzzes). */
    buzzMinMs: num(env.BUZZ_MIN_MS, 150),
    buzzMaxMs: num(env.BUZZ_MAX_MS, 1500),
    /** ably = like a phone (HTTP only if Ably fails); http = HTTP route only; both = send on both (tests dedupe). */
    buzzTransport: String(env.BUZZ_TRANSPORT ?? 'ably').toLowerCase(),
    /** % of buzzes that are double-tapped (same nonce sent twice; server must count once). */
    duplicateBuzzPct: num(env.DUPLICATE_BUZZ_PCT, 0),
    /** Late buzzes while the host is judging (phase `resolved`) for teams not yet in the order. */
    lateBuzzProbability: num(env.LATE_BUZZ_PROBABILITY, 0),
    /** Network chaos: every CHAOS_INTERVAL_SEC, drop this % of bots' Ably connections, reconnect after CHAOS_DOWN_SEC via token rejoin. */
    chaosDropPct: num(env.CHAOS_DROP_PCT, 0),
    chaosIntervalSec: num(env.CHAOS_INTERVAL_SEC, 60),
    chaosDownSec: num(env.CHAOS_DOWN_SEC, 8),
    /** Bots leave after this many minutes even if the host never ends the game. */
    stayMin: num(env.STAY_MIN, 120),
    reportEverySec: num(env.REPORT_EVERY_SEC, 30),
    requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, 10000),
    joinRetries: num(env.JOIN_RETRIES, 6),
    verbose: ['1', 'true', 'yes'].includes(String(env.VERBOSE ?? '').toLowerCase()),
  };

  if (cfg.players < 1 || cfg.players > 1000) throw new Error('PLAYERS must be 1-1000');
  if (cfg.teamSize < 1 || cfg.teamSize > 10) throw new Error('TEAM_SIZE must be 1-10 (server max team size is 10)');
  if (!['ably', 'http', 'both'].includes(cfg.buzzTransport)) throw new Error('BUZZ_TRANSPORT must be ably, http or both');
  if (!['staggered', 'random'].includes(cfg.buzzPattern)) throw new Error('BUZZ_PATTERN must be staggered or random');
  if (!['per-bot', 'shared'].includes(cfg.clockSync)) throw new Error('CLOCK_SYNC must be per-bot or shared');
  if (!['full', 'diff', 'off'].includes(cfg.orderTable)) throw new Error('ORDER_TABLE must be full, diff or off');
  if (cfg.rounds < 0) throw new Error('ROUNDS must be 0 (unlimited) or more');
  if (cfg.buzzStartMs < 120) throw new Error('BUZZ_START_MS must be >= 120: the server floors every press at armAt + 120ms, so earlier presses all tie');
  if (cfg.buzzMaxMs < cfg.buzzMinMs) throw new Error('BUZZ_MAX_MS must be >= BUZZ_MIN_MS');
  return cfg;
}

/** Config safe to print / expose on /status. */
export function describeConfig(cfg) {
  return { ...cfg, startAtIst: formatIst(cfg.startAt) };
}

// Run by mistake (`node lib/...` or an editor's "Run file")? This module only defines code; say so instead of exiting silently.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  console.error('This file is a library and does nothing on its own.\nRun the swarm with:  npm run cli   (or: node cli.mjs --help)\nRender service:     npm start');
  process.exitCode = 1;
}
