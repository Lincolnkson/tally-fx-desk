# Tally

A trade desk for the n8n **Forex Confluence Advisor**. The advisor posts its daily brief and trade signals here instead of Telegram; you log what you actually did; Tally measures how the advisor and you are doing, and lets you replay the strategy over past prices.

Works on desktop and phone, and installs to the home screen as an app.

## What it does

| Screen | What you get |
| --- | --- |
| **Desk** | Today's signals with a score breakdown and a stop/entry/target ruler, open trades showing where price sits in R, equity, win rate, this week's result, and the full daily brief. |
| **Signals** | Every signal the advisor ever sent, taken or not, with what it would have made if followed exactly. |
| **Trades** | Your journal: fills, partial profits, trailing stops, notes, tags, a pre-trade checklist, CSV export. |
| **Insights** | Win rate, expectancy, profit factor, drawdown, equity curve, result spread, a 12-week calendar, profit-taking stats (how often T1 and T2 were reached, how much of each winner you kept), and breakdowns by score, setup, pair, market mood, weekday and AI verdict. Plain-language findings, each gated on a minimum sample. |
| **Lab** | Backtests the advisor's exact rules on up to 8 years of daily candles, with costs, portfolio limits, a score-threshold sweep and a Monte Carlo "luck test". |
| **Inbox** | Briefs, new signals and exit-guardian alerts, live. |
| **Settings** | Central-bank rates, direction and meeting dates (the advisor reads these on every run), risk per trade, and circuit breakers. |

Ideas beyond the brief:

- **Shadow scorecard.** Every signal is replayed against real prices whether you took it or not, so you can see whether your skips, and the AI risk officer's rejections, help or hurt. The gap between your real result and the plan's result is your execution cost.
- **Circuit breakers.** Daily and weekly loss limits in R, a losing-streak pause and an open-risk cap. When one trips, the Desk tells you to stand aside and the advisor stops posting signals.
- **Discipline tracking.** When you close a trade you say whether you followed the plan; Insights compares the two.
- **One engine.** The backtester and shadow tracker use the same scoring and exit rules as the n8n workflows.

## Run it locally

```bash
npm install
npm run demo        # sample data on http://localhost:3000, password "demo", offline prices
npm test            # API smoke test and backtest test
```

For a real instance: copy `.env.example` to `.env`, set the three secrets, then `npm start`.

## Deploy on Railway

1. **New Project → Deploy from GitHub repo**, and pick this repo. `railway.json` sets the start command and a `/health` check.
2. **Add a volume** to the service, mounted at `/data`. The database lives there and survives redeploys. Without it, every deploy starts empty.
3. **Variables:** set `APP_PASSWORD`, `SESSION_SECRET` (`openssl rand -hex 32`) and `INGEST_API_KEY` (`openssl rand -hex 24`).
4. **Settings → Networking → Generate Domain.** That URL is your app.
5. In n8n, put the app URL and `INGEST_API_KEY` into the two workflows (see below).

## How n8n talks to Tally

Every ingest call sends the header `x-api-key: <INGEST_API_KEY>`.

| Call | Who | Purpose |
| --- | --- | --- |
| `GET /api/ingest/macro` | Advisor, at the start of each run | Rates, policy direction, meeting dates, risk settings, current equity, and whether a circuit breaker says stand aside. |
| `POST /api/ingest/brief` | Advisor | Daily brief: `{ runAt, regime, vix, pairs: [...] }`. |
| `POST /api/ingest/signal` | Advisor, once per ENTER signal | One trade ticket, including the AI verdict. Duplicate `signalId`s are ignored. |
| `GET /api/ingest/open-trades` | Exit guardian | Trades you logged as taken. |
| `POST /api/ingest/guardian` | Exit guardian | `{ updates: [...] }` with price, R, trailing stop and advice. Stops only ever tighten. |

## Honest limits

- Prices come from Yahoo's public chart endpoint. It is unofficial and can change or rate-limit.
- Backtests use daily candles. When a day touches both the stop and a target, the stop is assumed to fill first.
- There is no history of past news or past central-bank rates, so backtests either apply today's rate picture to every past day (which flatters the fundamental filter) or ignore fundamentals. Compare both.
- Tally is a decision aid and journal. It never places trades, and nothing in it is financial advice.
