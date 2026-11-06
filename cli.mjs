#!/usr/bin/env node
/**
 * Local runner. Joins N headless players to a Virtual Buzzer game at a given IST time.
 *
 *   node cli.mjs --at "06 11 18 30 00" --pin 1234 --url https://buzzer.awspf.com
 *   node cli.mjs --at now --pin 1234 --players 40 --team-size 4 --chaos 10
 *
 * Every flag has an env twin (see .env.example); flags win. `node --env-file=.env cli.mjs`
 * (or `npm start`) reads a .env file. Ctrl+C leaves the game cleanly and prints the report.
 * Exit code: 0 = ran, 1 = bad config / run error, 2 = some bots failed to join.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { describeConfig, formatIst, loadConfig } from './lib/config.mjs';
import { Swarm } from './lib/swarm.mjs';

const FLAGS = {
  at: 'START_AT',
  pin: 'PIN',
  url: 'BACKEND_URL',
  players: 'PLAYERS',
  'join-spread': 'JOIN_SPREAD_SEC',
  'team-size': 'TEAM_SIZE',
  prefix: 'NAME_PREFIX',
  rounds: 'ROUNDS',
  pattern: 'BUZZ_PATTERN',
  'buzz-start': 'BUZZ_START_MS',
  'buzz-gap': 'BUZZ_GAP_MS',
  'clock-sync': 'CLOCK_SYNC',
  skew: 'CLOCK_SKEW_MS',
  table: 'ORDER_TABLE',
  'buzz-prob': 'BUZZ_PROBABILITY',
  'buzz-min': 'BUZZ_MIN_MS',
  'buzz-max': 'BUZZ_MAX_MS',
  transport: 'BUZZ_TRANSPORT',
  dup: 'DUPLICATE_BUZZ_PCT',
  late: 'LATE_BUZZ_PROBABILITY',
  chaos: 'CHAOS_DROP_PCT',
  'chaos-every': 'CHAOS_INTERVAL_SEC',
  'chaos-down': 'CHAOS_DOWN_SEC',
  stay: 'STAY_MIN',
  report: 'REPORT_EVERY_SEC',
  'report-file': 'REPORT_FILE',
};

let parsed;
try {
  parsed = parseArgs({
    options: {
      ...Object.fromEntries(Object.keys(FLAGS).map((k) => [k, { type: 'string' }])),
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  }).values;
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (parsed.help) {
  console.log(`Usage: node cli.mjs --at "dd mm hh mm ss" --pin 1234 --url https://backend [options]

  --at           start time in IST: "dd mm hh mm ss" (e.g. "06 11 18 30 00") or "now"
  --pin          4-digit game pin
  --url          Virtual Buzzer backend URL (same as VITE_BUZZER_BACKEND_URL)
  --players      number of bots (default 40)
  --join-spread  seconds to spread joins over, 0 = burst (default 20)
  --team-size    bots per team in a team game, 1 = each its own team (default 1)
  --prefix       bot name prefix (default "Bot")
  --rounds       rounds to play, then print the reports (default 6; 0 = until the game ends)
  --pattern      staggered | random (default staggered: shuffled, one press every --buzz-gap ms)
  --buzz-start   staggered: first press this many ms after armAt (default 200, min 120)
  --buzz-gap     staggered: ms between presses (default 30; <=15 is the server's tie window)
  --clock-sync   per-bot | shared (default per-bot: every bot syncs its own clock like a phone)
  --skew         per-bot: simulate device clocks off by up to ±this many ms (default 0)
  --table        full | diff | off  per-round detail table in the report (default full)
  --buzz-prob    chance a bot buzzes per round, 0-1 (default 1)
  --buzz-min/max random pattern: reaction time after armAt in ms (default 150 / 1500)
  --transport    ably | http | both (default ably, HTTP only as fallback)
  --dup          % of buzzes double-tapped with the same nonce (default 0)
  --late         chance to buzz late while the host is judging (default 0)
  --chaos        % of bots whose connection drops every --chaos-every s (default 0)
  --stay         minutes to stay if the game never ends (default 120)
  --report-file  also write the final JSON report here
  -v, --verbose  log every join`);
  process.exit(0);
}

const env = { ...process.env };
for (const [flag, key] of Object.entries(FLAGS)) if (parsed[flag] !== undefined) env[key] = parsed[flag];
if (parsed.verbose) env.VERBOSE = 'true';

let cfg;
try {
  cfg = loadConfig(env);
} catch (err) {
  console.error(`Config error: ${err.message}\nRun with --help for usage.`);
  process.exit(1);
}

const lateBy = Date.now() - cfg.startAt;
if (lateBy > 60_000) {
  console.error(`START_AT ${formatIst(cfg.startAt)} is ${Math.round(lateBy / 60000)} min in the past. Use "now" or a future time.`);
  process.exit(1);
}

const stamp = () => formatIst(Date.now()).slice(11, 19);
const log = {
  info: (s) => console.log(`${stamp()} ${s}`),
  warn: (s) => console.warn(`${stamp()} WARN ${s}`),
  error: (s) => console.error(`${stamp()} ERROR ${s}`),
};

log.info(`Config: ${JSON.stringify(describeConfig(cfg))}`);
const swarm = new Swarm(cfg, log);

let interrupted = 0;
process.on('SIGINT', () => {
  interrupted += 1;
  if (interrupted > 1) process.exit(130);
  log.info('Ctrl+C: leaving the game (press again to force quit)');
  swarm.stop('stopped');
});
process.on('SIGTERM', () => swarm.stop('stopped'));

const report = await swarm.run();
if (env.REPORT_FILE) {
  writeFileSync(env.REPORT_FILE, JSON.stringify({ config: describeConfig(cfg), report }, null, 2));
  log.info(`Report written to ${env.REPORT_FILE}`);
}
// Ably sockets can keep the loop alive briefly after close().
setTimeout(() => process.exit(report.status === 'error' ? 1 : report.counts.joinFailed ? 2 : 0), 1500).unref();
