# vb-load-test: Virtual Buzzer player swarm

This tool runs headless players that join a Virtual Buzzer game at a time you choose (IST) and play it the same way a phone does:

- clock sync
- join by pin
- Ably events
- buzz at `armAt` plus a human reaction time
- HTTP fallback
- token renewal by rejoining

It runs at the protocol level, so it needs no browser and no Playwright. It follows `client/src/pages/Games/VirtualBuzzer/api/usePlayerSession.ts` and the backend contract (`play-factile-backend/src/contract`, 5.2.0).

**You do not need an Ably key.** The gameplay server mints each player's Ably token when the player joins. All a run needs is the backend URL and the pin.

```
lib/config.mjs   settings (env vars) + IST time parsing
lib/swarm.mjs    the bots + metrics + report
cli.mjs          script 1: run from your machine
server.mjs       script 2: Render web service (free plan, no background worker)
```

## Script 1: local CLI

```bash
cd vb-load-test
npm install
node cli.mjs --at "06 11 18 30 00" --pin 1234 --url https://buzzer.awspf.com
```

- `--at` is the start time in IST, as `dd mm hh mm ss` (day month hour minute second, 24-hour). Any separators work: `"06-11 18:30:00"` also works. `--at now` starts immediately. The year is the current year.
- Every flag has an env twin. Copy `.env.example` to `.env` and run `npm run cli`. Flags override `.env`.
- Press Ctrl+C to leave the game cleanly and print the report. The run also ends by itself when the host ends the game, or after `STAY_MIN`.
- `--report-file out.json` also saves the report as JSON.
- `node cli.mjs --help` lists every option.

Useful variations:

| Goal | Flags |
| --- | --- |
| 40 players in teams of 4 | `--team-size 4` (ignored in a solo game) |
| Everyone joins at the same instant | `--join-spread 0` |
| Test reconnect and rejoin | `--chaos 10 --chaos-every 30 --chaos-down 8` |
| Test nonce dedupe | `--transport both` or `--dup 20` |
| Late buzzes while the host judges | `--late 0.5` |
| Run two swarms against one game | give each a different `--prefix` |

## Script 2: Render (free web service)

1. Push this folder. In Render, choose **New → Web Service** for the repo:
   - **Root Directory:** `vb-load-test`
   - **Build:** `npm install --omit=dev`
   - **Start:** `npm start`
   - **Health check path:** `/healthz`
   - **Plan:** Free

   Alternatively, `render.yaml` in this folder holds the same settings. To use it as a Blueprint, point the Blueprint at it or move it to the repo root.
2. Set the environment variables listed in `.env.example`. The minimum is `BACKEND_URL`, `PIN`, `START_AT` and `CONTROL_TOKEN` (a long random string). Also set `NODE_VERSION=22`.
3. Deploy. The run is scheduled at boot. Open the service URL to see its status:

| URL | What it shows |
| --- | --- |
| `/` | status and recent log |
| `/status` | JSON with live progress and the report |
| `/logs` | the last 500 log lines |

The full log is also in Render's **Logs** tab.

To start another run without redeploying, call the control endpoints. Body fields override the env vars:

```bash
curl -X POST "https://<svc>.onrender.com/run?token=$CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"PIN":"5678","START_AT":"06 11 21 00 00","TEAM_SIZE":"4"}'
curl -X POST "https://<svc>.onrender.com/stop?token=$CONTROL_TOKEN"
```

GET works for both endpoints too, so you can fire them from a browser: `/run?token=…&pin=5678&start_at=now`.

### Free-plan limits to know

- **The instance sleeps after 15 minutes with no inbound traffic.** While a run is scheduled or active, the service pings its own `RENDER_EXTERNAL_URL/healthz` every `KEEP_ALIVE_MIN` (10) minutes so it stays awake until `START_AT`. After the run it stops pinging and the instance can sleep. For extra safety on a long wait, add a free external pinger (UptimeRobot or cron-job.org) on `/healthz`.
- **A restart or redeploy loses the run.** On boot, a `START_AT` up to `LATE_START_GRACE_MIN` (5) minutes in the past still starts immediately. Anything older is skipped. Bots that rejoin after a restart are new players, so their names get a suffix (`Bot 07-x3k`).
- **CPU is 0.1 vCPU.** Forty bots fit comfortably. For timing-sensitive fairness numbers, the local CLI is the cleaner measurement.

## Reading the report

| Line | Meaning |
| --- | --- |
| `join errors` | Server error codes (`rate_limited`, `session_full`, `name_taken`, …). `rate_limited` is retried automatically, honouring `Retry-After`. All bots share one IP, so the backend's `JOIN_RATE_LIMIT` applies to the whole swarm. |
| `latency eventDelivery` | Server `at` → bot receipt, on the synced clock. |
| `armLead` | How long before `armAt` the `question.armed` event reached the bots. Positive means good: buttons open in sync. Negative means the event arrived after the buzzer opened. |
| `armedSeenBy` / `resolvedSeenBy` | How many bots saw each event. Both should equal the number of bots. |
| `serverTotalBuzzed` | Teams counted in the resolution window. Later buzzes show up as `buzz.appended`. |
| `version gaps` | Events that arrived ahead of an earlier version. Every gap costs each phone one snapshot fetch. |
| `rejoinGotNewSeat!` | Should never appear. It means a token rejoin created a duplicate player. |
| `kicked` | Bots the host removed. Useful for testing the kick flow. |

Exit codes: `0` means the run completed. `1` means a config or run error. `2` means some bots never joined.
