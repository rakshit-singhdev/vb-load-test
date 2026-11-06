/**
 * Render "Web Service" runner (free plan has no background workers).
 *
 * Binds $PORT so Render sees a healthy web service, and runs the swarm inside
 * the same process. On boot it schedules a run from the env vars (START_AT,
 * PIN, BACKEND_URL, ...). More runs can be started without a redeploy through
 * the control endpoints, protected by CONTROL_TOKEN.
 *
 * Free instances spin down after 15 min without inbound HTTP. While a run is
 * scheduled or active, the service pings its own public URL (RENDER_EXTERNAL_URL,
 * which Render sets) every KEEP_ALIVE_MIN minutes so it stays awake until START_AT.
 *
 *   GET  /              human-readable status + recent log
 *   GET  /healthz       "ok" (Render health check + keep-alive target)
 *   GET  /status        JSON: config, live progress, report
 *   GET  /logs          last LOG_BUFFER lines, plain text
 *   POST /run?token=..  start a run; JSON body (or query) overrides env, e.g. {"PIN":"1234","START_AT":"06 11 18 30 00"}
 *   POST /stop?token=.. leave the game now and produce the report
 *   (GET works for /run and /stop too, so they can be fired from a browser bar.)
 */
import { createServer } from 'node:http';

import { describeConfig, formatIst, loadConfig } from './lib/config.mjs';
import { Swarm } from './lib/swarm.mjs';

const PORT = Number(process.env.PORT ?? 10000);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN ?? '';
const SELF_URL = (process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const KEEP_ALIVE_MIN = Number(process.env.KEEP_ALIVE_MIN ?? 10);
/** `while-running` (default) lets the free instance sleep once a run is over; `always` never lets it sleep. */
const KEEP_ALIVE = process.env.KEEP_ALIVE ?? 'while-running';
/** After a restart/redeploy, a START_AT this many minutes in the past still starts (immediately). Older ones are skipped. */
const LATE_START_GRACE_MIN = Number(process.env.LATE_START_GRACE_MIN ?? 5);
const LOG_BUFFER = Number(process.env.LOG_BUFFER ?? 500);

// ---------------------------------------------------------------------------
// Logging: stdout (Render's log tab) + ring buffer (/logs)
// ---------------------------------------------------------------------------

const lines = [];
const push = (level, s) => {
  const line = `${formatIst(Date.now()).slice(11, 19)} ${level === 'info' ? '' : `${level.toUpperCase()} `}${s}`;
  (level === 'error' ? console.error : console.log)(line);
  for (const l of line.split('\n')) lines.push(l);
  while (lines.length > LOG_BUFFER) lines.shift();
};
const log = { info: (s) => push('info', s), warn: (s) => push('warn', s), error: (s) => push('error', s) };

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

let current = null; // { swarm, cfg, startedAt, report }
let lastConfigError = null;

function startRun(overrides = {}) {
  if (current && ['scheduled', 'joining', 'running'].includes(current.swarm.status)) {
    throw Object.assign(new Error(`a run is already ${current.swarm.status}; POST /stop first`), { status: 409 });
  }
  const cfg = loadConfig({ ...process.env, ...overrides });
  const lateBy = Date.now() - cfg.startAt;
  if (lateBy > LATE_START_GRACE_MIN * 60_000) {
    throw Object.assign(new Error(`START_AT ${formatIst(cfg.startAt)} is ${Math.round(lateBy / 60000)} min in the past`), { status: 400 });
  }
  const swarm = new Swarm(cfg, log);
  current = { swarm, cfg, startedAt: Date.now(), report: null };
  log.info(`Run scheduled: ${cfg.players} players, pin ${cfg.pin}, start ${formatIst(cfg.startAt)}, backend ${cfg.backendUrl}`);
  const run = current;
  void swarm.run().then((report) => {
    run.report = report;
  });
  return run;
}

// Boot-time run from env, if configured.
if (process.env.PIN && process.env.BACKEND_URL) {
  try {
    startRun();
  } catch (err) {
    lastConfigError = err.message;
    log.warn(`No run scheduled at boot: ${err.message}`);
  }
} else {
  log.info('PIN / BACKEND_URL not set: idle until POST /run');
}

// ---------------------------------------------------------------------------
// Keep-alive (free plan sleeps after 15 min with no inbound traffic)
// ---------------------------------------------------------------------------

const isActive = () => current && ['scheduled', 'joining', 'running'].includes(current.swarm.status);
if (SELF_URL && KEEP_ALIVE !== 'off') {
  setInterval(() => {
    if (KEEP_ALIVE !== 'always' && !isActive()) return;
    fetch(`${SELF_URL}/healthz`, { signal: AbortSignal.timeout(15000) }).catch((err) => log.warn(`keep-alive ping failed: ${err.message}`));
  }, KEEP_ALIVE_MIN * 60_000);
  log.info(`Keep-alive: pinging ${SELF_URL}/healthz every ${KEEP_ALIVE_MIN} min (${KEEP_ALIVE})`);
} else {
  log.warn('Keep-alive off (no RENDER_EXTERNAL_URL / KEEP_ALIVE_URL): a free instance will sleep after 15 min idle');
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function statusJson() {
  if (!current) return { status: 'idle', lastConfigError };
  const { swarm, cfg, startedAt, report } = current;
  return {
    status: swarm.status,
    scheduledAt: formatIst(startedAt),
    config: describeConfig(cfg),
    progress: swarm.status === 'running' || swarm.status === 'joining' ? swarm.progressLine() : undefined,
    report: report ?? swarm.report(),
  };
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body, null, 2) : body);
};

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('body must be JSON'), { status: 400 });
  }
}

function authorized(req, url) {
  if (!CONTROL_TOKEN) return false;
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  return header === CONTROL_TOKEN || url.searchParams.get('token') === CONTROL_TOKEN;
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (url.pathname === '/status') return send(res, 200, statusJson());
    if (url.pathname === '/logs') return send(res, 200, lines.join('\n'), 'text/plain');
    if (url.pathname === '/') {
      const s = statusJson();
      const head = current
        ? `status: ${s.status}\nstart:  ${s.config.startAtIst}\npin:    ${s.config.pin}\nbots:   ${s.config.players}\n${s.progress ?? ''}\n`
        : `status: idle${lastConfigError ? `\nlast config error: ${lastConfigError}` : ''}\n`;
      return send(res, 200, `Virtual Buzzer swarm\n\n${head}\n--- recent log (/logs for more, /status for JSON) ---\n${lines.slice(-60).join('\n')}\n`, 'text/plain');
    }
    if (url.pathname === '/run' || url.pathname === '/stop') {
      if (!CONTROL_TOKEN) return send(res, 403, { error: 'set CONTROL_TOKEN in the Render env to enable /run and /stop' });
      if (!authorized(req, url)) return send(res, 401, { error: 'bad or missing token' });
      if (url.pathname === '/stop') {
        if (!isActive()) return send(res, 409, { error: 'nothing running' });
        current.swarm.stop('stopped');
        return send(res, 200, { ok: true, message: 'stopping; report at /status in a moment' });
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      const overrides = { ...body };
      for (const [k, v] of url.searchParams) if (k !== 'token') overrides[k.toUpperCase()] = v;
      const run = startRun(overrides);
      return send(res, 202, { ok: true, config: describeConfig(run.cfg) });
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, err.status ?? 400, { error: err.message });
  }
}).listen(PORT, '0.0.0.0', () => log.info(`Swarm service listening on :${PORT}`));

const shutdown = () => {
  log.info('Shutting down: leaving the game');
  if (isActive()) current.swarm.stop('stopped');
  setTimeout(() => process.exit(0), 2500).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
