/**
 * Turns a finished swarm into the set of reports printed at the end:
 *   1. run summary   2. clock sync   3. buzz order per round (summary)
 *   4. buzz order per round (detail tables)   5. latency   6. verdict
 *
 * "True" order = when each bot actually pressed, on the swarm's one reference
 * clock. "Server" order = the full ranking from the snapshot. The server ranks
 * by tEff = pressedAt, but no earlier than edgeAt - cap (50 ms) or armAt + 120 ms,
 * and shuffles teams whose tEff are within 15 ms (TIE_MS) on purpose.
 */

/** The server's tie window (arbiter.ts `tieMs`): presses closer than this are shuffled by design. */
export const TIE_MS = 15;

function pct(values, p) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}
export function stats(values) {
  if (values.length === 0) return 'n/a';
  return `n=${values.length} p50=${pct(values, 50)}ms p95=${pct(values, 95)}ms max=${Math.round(Math.max(...values))}ms`;
}
const absStats = (values) => stats(values.map(Math.abs));
const pad = (v, n) => String(v ?? '-').padStart(n);
const padR = (v, n) => String(v ?? '-').padEnd(n);
const signed = (v) => (v === null || v === undefined ? '-' : `${v >= 0 ? '+' : ''}${Math.round(v)}`);

/**
 * Compares one round's server order with the true press order.
 * Team games rank one row per team, so truth is per team: its earliest press.
 */
export function analyzeRound(r, swarm) {
  const teamTruth = new Map();
  for (const p of r.presses.values()) {
    const cur = teamTruth.get(p.teamId);
    if (!cur || p.truePressAt < cur.truePressAt) teamTruth.set(p.teamId, p);
  }
  const order = r.finalOrder ?? [];
  const windowCount = r.resolvedEvent?.totalBuzzed ?? null;
  const humans = order.filter((row) => !teamTruth.has(row.teamId)).map((row) => row.rank);
  const botRows = order
    .filter((row) => teamTruth.has(row.teamId))
    .map((row) => ({ row, truth: teamTruth.get(row.teamId), appended: windowCount !== null && row.rank > windowCount }));
  const expected = [...botRows].sort((a, b) => a.truth.truePressAt - b.truth.truePressAt);
  const expPos = new Map(expected.map((x, i) => [x.row.teamId, i + 1]));
  const ranked = new Set(order.map((row) => row.teamId));
  const missing = [...teamTruth.values()].filter((p) => !ranked.has(p.teamId)).map((p) => p.name);

  // Every pair the server put in the opposite order to the true presses.
  let realInversions = 0;
  let tieInversions = 0;
  const causes = {};
  const flagged = new Set();
  for (let i = 0; i < botRows.length; i++) {
    for (let j = i + 1; j < botRows.length; j++) {
      const a = botRows[i]; // ranked earlier by the server...
      const b = botRows[j];
      const gap = a.truth.truePressAt - b.truth.truePressAt; // ...but pressed `gap` ms later
      if (gap <= 0) continue;
      if (gap <= TIE_MS) {
        tieInversions += 1;
        continue;
      }
      realInversions += 1;
      flagged.add(a.row.teamId);
      flagged.add(b.row.teamId);
      // Why: the phone's clock stamped them backwards, b's buzz landed after the
      // collection window closed, or delivery delay beyond the 50 ms credit cap.
      let cause = 'delivery>cap';
      if (a.row.pressedAt <= b.row.pressedAt) cause = 'clock-sync';
      else if (b.appended && !a.appended) cause = 'after-window';
      causes[cause] = (causes[cause] ?? 0) + 1;
    }
  }
  const n = botRows.length;
  const pairs = (n * (n - 1)) / 2;
  const tau = pairs > 0 ? 1 - (2 * (realInversions + tieInversions)) / pairs : null;
  const armAt = r.armAt ?? order[0]?.edgeAt ?? 0;

  const rows = order.map((row) => {
    const t = teamTruth.get(row.teamId);
    const srv = botRows.findIndex((x) => x.row.teamId === row.teamId) + 1;
    const exp = t ? expPos.get(row.teamId) : null;
    return {
      rank: row.rank,
      name: t ? t.name : `(human) ${row.teamId.slice(0, 8)}`,
      bot: Boolean(t),
      slot: t?.slot ?? null,
      expectedRank: exp,
      botRank: t ? srv : null,
      delta: t ? srv - exp : null,
      truePressMs: t ? t.truePressAt - armAt : null,
      claimedMs: row.pressedAt - armAt,
      edgeMs: row.edgeAt - armAt,
      tEffMs: row.tEff - armAt,
      syncErrMs: t ? row.pressedAt - t.truePressAt : null,
      deliveryMs: t ? row.edgeAt - t.truePressAt : null,
      creditMs: row.edgeAt - row.tEff,
      appended: windowCount !== null && row.rank > windowCount,
      inversion: flagged.has(row.teamId),
    };
  });

  return {
    round: r.roundNo,
    questionId: r.questionId,
    attempt: r.attempt,
    armAt: r.armAt,
    pressed: teamTruth.size,
    ranked: n,
    humansInOrder: humans.length,
    missing,
    windowCount,
    appendedCount: rows.filter((x) => x.appended && x.bot).length,
    realInversions,
    tieInversions,
    causes,
    maxDisplacement: rows.reduce((mx, x) => Math.max(mx, Math.abs(x.delta ?? 0)), 0),
    tau: tau === null ? null : Number(tau.toFixed(3)),
    firstOk: n > 0 && botRows[0].row.teamId === expected[0].row.teamId,
    humanFirst: order.length > 0 && !teamTruth.has(order[0].teamId),
    preserved: n > 0 && realInversions === 0 && missing.length === 0,
    resolvedAfterArmMs: r.resolvedEvent && r.armAt ? r.resolvedEvent.at - r.armAt : null,
    armedSeenBy: r.armedSeen,
    armLead: stats(r.armLeadMs),
    resolvedSeenBy: r.resolvedSeen,
    outcomes: r.outcomes,
    orderSource: r.orderSource ?? 'none',
    delivery: stats(rows.filter((x) => x.bot).map((x) => x.deliveryMs)),
    syncErr: absStats(rows.filter((x) => x.bot).map((x) => x.syncErrMs)),
    rows,
  };
}

function botClockSummary(swarm) {
  const own = swarm.bots.filter((b) => b.clock !== swarm.ref && b.clock.syncs > 0);
  return {
    mode: swarm.cfg.clockSync,
    reference: { offsetMs: Math.round(swarm.ref.offset), rttMs: swarm.ref.rtt, syncs: swarm.ref.syncs },
    botsSynced: own.length,
    syncsTotal: own.reduce((s, b) => s + b.clock.syncs, 0),
    rtt: stats(own.map((b) => b.clock.rtt)),
    skewApplied: swarm.cfg.clockSkewMs ? absStats(own.map((b) => b.clock.skewMs)) : 'none',
    // How far each bot's synced clock is from the reference right now: the residual sync error.
    residualNow: absStats(own.map((b) => b.clock.now() - swarm.ref.now())),
  };
}

export function buildReports(swarm) {
  const { cfg, m } = swarm;
  const by = {};
  for (const b of swarm.bots) by[b.state] = (by[b.state] ?? 0) + 1;
  const rounds = [...swarm.rounds.values()].sort((a, b) => a.roundNo - b.roundNo || a.attempt - b.attempt).map((r) => analyzeRound(r, swarm));
  const clock = botClockSummary(swarm);
  const allSyncErr = rounds.flatMap((x) => x.rows.filter((y) => y.bot).map((y) => y.syncErrMs));
  const allDelivery = rounds.flatMap((x) => x.rows.filter((y) => y.bot).map((y) => y.deliveryMs));
  const blocked = m.counts['pressBlockedBeforeArm(clock error)'] ?? 0;

  const json = {
    status: swarm.status,
    finishReason: swarm.finishReason,
    error: swarm.error,
    mode: swarm.mode,
    pin: cfg.pin,
    sessionId: swarm.sessionId,
    bots: by,
    counts: m.counts,
    joinErrors: m.joinErrors,
    rejoinErrors: m.rejoinErrors,
    ablyStates: m.ablyStates,
    resyncs: m.resyncs,
    versionGaps: m.gapsBy,
    eventsByType: m.eventsByType,
    clock: { ...clock, pressSyncError: absStats(allSyncErr), pressesBlockedBeforeArm: blocked },
    latency: {
      join: stats(m.joinMs),
      rejoin: stats(m.rejoinMs),
      ablyConnect: stats(m.ablyConnectMs),
      eventDelivery: stats(m.eventDelayMs),
      buzzDeliveryToServer: stats(allDelivery),
      ablyBuzzPublishAck: stats(m.ablyPublishMs),
      httpBuzz: stats(m.httpBuzzMs),
    },
    rounds,
    verdict: {
      rounds: rounds.length,
      preserved: rounds.filter((x) => x.preserved).length,
      firstPlaceCorrect: rounds.filter((x) => x.firstOk).length,
      realInversions: rounds.reduce((s, x) => s + x.realInversions, 0),
      tieInversions: rounds.reduce((s, x) => s + x.tieInversions, 0),
      missingBuzzes: rounds.reduce((s, x) => s + x.missing.length, 0),
    },
  };

  const L = [];
  const H = (title) => L.push('', `==================== ${title} ${'='.repeat(Math.max(0, 60 - title.length))}`);

  H('1. RUN SUMMARY');
  L.push(`status ${json.status}${json.finishReason ? ` (${json.finishReason})` : ''}${json.error ? `  ERROR: ${json.error}` : ''}`);
  L.push(`pin ${cfg.pin}  mode ${json.mode}  session ${json.sessionId ?? '-'}  bots ${JSON.stringify(by)}`);
  L.push(`plan: ${cfg.rounds || 'unlimited'} rounds, pattern ${cfg.buzzPattern}${cfg.buzzPattern === 'staggered' ? ` (start +${cfg.buzzStartMs}ms, gap ${cfg.buzzGapMs}ms)` : ` (${cfg.buzzMinMs}-${cfg.buzzMaxMs}ms)`}, transport ${cfg.buzzTransport}`);
  L.push(`counts        ${JSON.stringify(m.counts)}`);
  L.push(`join errors   ${JSON.stringify(m.joinErrors)}   rejoin errors ${JSON.stringify(m.rejoinErrors)}`);
  L.push(`ably states   ${JSON.stringify(m.ablyStates)}   resyncs ${JSON.stringify(m.resyncs)}   round resets ${JSON.stringify(m.roundResets)}`);
  L.push(`version gaps  ${JSON.stringify(m.gapsBy)}  (event that arrived ahead of an earlier one; each = 1 snapshot fetch per phone)`);
  L.push(`events        ${JSON.stringify(m.eventsByType)}`);

  H('2. CLOCK SYNC');
  L.push(`mode ${clock.mode}. Reference clock (truth): offset ${clock.reference.offsetMs}ms, rtt ${clock.reference.rttMs}ms`);
  if (clock.mode === 'per-bot') {
    L.push(`bots synced ${clock.botsSynced}/${swarm.bots.length}, ${clock.syncsTotal} syncs total (join + re-sync when a question opens and the last sync is >5 min old)`);
    L.push(`bot rtt               ${clock.rtt}`);
    L.push(`simulated device skew ${clock.skewApplied}${cfg.clockSkewMs ? ` (each bot's own clock off by up to ±${cfg.clockSkewMs}ms before sync)` : ''}`);
    L.push(`residual error now    ${clock.residualNow}   (bot synced clock vs reference)`);
  }
  L.push(`at press time         ${json.clock.pressSyncError}   (claimed pressedAt vs true press)`);
  L.push(`presses blocked       ${blocked}   (bot's clock said "before armAt" when the human pressed)`);

  H('3. BUZZ ORDER: ROUND SUMMARY');
  L.push(`${padR('round', 9)}${pad('pressed', 8)}${pad('ranked', 7)}${pad('human', 6)}${pad('miss', 5)}${pad('inWin', 6)}${pad('real', 5)}${pad('tie', 4)}${pad('tau', 7)}${pad('first', 6)}  ${padR('preserved', 10)}${pad('arm→res', 8)}  delivery / sync-err`);
  for (const x of rounds) {
    L.push(
      `${padR(`${x.round}${x.attempt > 1 ? `.${x.attempt}` : ''} ${x.questionId}`, 9)}${pad(x.pressed, 8)}${pad(x.ranked, 7)}${pad(x.humansInOrder, 6)}${pad(x.missing.length, 5)}${pad(x.windowCount, 6)}` +
        `${pad(x.realInversions, 5)}${pad(x.tieInversions, 4)}${pad(x.tau, 7)}${pad(x.firstOk ? 'yes' : 'NO', 6)}  ${padR(x.preserved ? 'YES' : 'NO', 10)}${pad(x.resolvedAfterArmMs === null ? '-' : `${x.resolvedAfterArmMs}ms`, 8)}  ${x.delivery} / ${x.syncErr}`
    );
    if (Object.keys(x.causes).length) L.push(`         inversion causes ${JSON.stringify(x.causes)}`);
    if (x.missing.length) L.push(`         MISSING (pressed, never ranked): ${x.missing.join(', ')}`);
    if (x.orderSource !== 'snapshot') L.push(`         full order not read (${x.orderSource}): the host moved on before the snapshot poll`);
  }
  L.push('columns: inWin = teams ranked inside the collection window (rest appended by arrival); real = pairs out of order by >15ms; tie = pairs within the 15ms tie window (shuffled by design); tau = 1 perfect, 0 random');

  if (cfg.orderTable !== 'off') {
    H('4. BUZZ ORDER: PER-ROUND DETAIL');
    L.push('all times ms after armAt. true = actual press; claimed = pressedAt the bot sent (its synced clock); edge = arrival at Ably/server;');
    L.push('tEff = what the server ranked by; syncErr = claimed-true; delivery = edge-true; credit = edge-tEff (latency credit given, cap 50)');
    for (const x of rounds) {
      L.push('', `-- Round ${x.round}${x.attempt > 1 ? ` attempt ${x.attempt}` : ''} [${x.questionId}]  ${x.preserved ? 'ORDER PRESERVED' : 'ORDER NOT PRESERVED'}  (armed seen by ${x.armedSeenBy}, armLead ${x.armLead})`);
      L.push(`${pad('srv', 4)}${pad('exp', 4)}${pad('Δ', 4)}  ${padR('name', 16)}${pad('true', 7)}${pad('claimed', 8)}${pad('edge', 7)}${pad('tEff', 7)}${pad('syncErr', 8)}${pad('deliv', 7)}${pad('credit', 7)}  note`);
      const show = cfg.orderTable === 'diff' ? x.rows.filter((y) => !y.bot || y.delta !== 0 || y.inversion) : x.rows;
      for (const y of show) {
        const note = [y.inversion ? 'OUT OF ORDER' : '', y.appended ? 'appended' : '', y.bot ? '' : 'not a bot'].filter(Boolean).join(', ');
        L.push(
          `${pad(y.rank, 4)}${pad(y.expectedRank, 4)}${pad(y.delta === null ? '' : signed(y.delta), 4)}  ${padR(y.name.slice(0, 15), 16)}${pad(y.truePressMs === null ? '-' : Math.round(y.truePressMs), 7)}${pad(y.claimedMs, 8)}` +
            `${pad(y.edgeMs, 7)}${pad(y.tEffMs, 7)}${pad(signed(y.syncErrMs), 8)}${pad(y.deliveryMs === null ? '-' : Math.round(y.deliveryMs), 7)}${pad(y.creditMs, 7)}  ${note}`
        );
      }
      if (cfg.orderTable === 'diff' && show.length === 0) L.push('   (every bot in its expected position)');
    }
  }

  H('5. LATENCY');
  for (const [k, v] of Object.entries(json.latency)) L.push(`${padR(k, 22)} ${v}`);

  H('6. VERDICT');
  const v = json.verdict;
  if (v.rounds === 0) L.push('No rounds were played while the bots were in the game.');
  else {
    L.push(`Order preserved in ${v.preserved}/${v.rounds} rounds. First place correct in ${v.firstPlaceCorrect}/${v.rounds}.`);
    L.push(`Real inversions (>${TIE_MS}ms apart): ${v.realInversions}. Tie-window swaps (≤${TIE_MS}ms, by design): ${v.tieInversions}. Buzzes never ranked: ${v.missingBuzzes}.`);
    const causes = {};
    for (const x of rounds) for (const [k, n] of Object.entries(x.causes)) causes[k] = (causes[k] ?? 0) + n;
    if (Object.keys(causes).length) {
      L.push(`Inversion causes: ${JSON.stringify(causes)}`);
      L.push('  clock-sync   = the phones stamped pressedAt in the wrong order (sync error larger than the gap between presses)');
      L.push('  after-window = the later-ranked buzz reached the server after the collection window closed, so it was appended by arrival');
      L.push('  delivery>cap = stamps were right, but delivery took more than the 50ms the server credits, so arrival order won');
    }
  }
  L.push('='.repeat(81));

  return { text: L.join('\n'), json };
}

// Run by mistake (`node lib/...` or an editor's "Run file")? This module only defines code; say so instead of exiting silently.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  console.error('This file is a library and does nothing on its own.\nRun the swarm with:  npm run cli   (or: node cli.mjs --help)\nRender service:     npm start');
  process.exitCode = 1;
}
