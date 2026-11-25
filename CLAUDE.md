# Infoblade (InvestmentInformatics.AI)

AI market-intelligence app: Claude reads the news and makes calls on stocks,
crypto and prediction markets (Polymarket), and every call is graded later
against what actually happened. Web on Vercel, iOS via Capacitor.

## The goal

The **public track record is the product.** We pitch it to investors and
startups. Everything serves one claim: *"here is how often the AI is right,
measured honestly."* Accuracy work is about making real calls better, never
about making the number look better.

The mission is to **level the playing field**: give an average person the
below-the-surface research a dedicated trader does (filings, contracts,
insider and fund activity), made readable. The aim is parity with
experienced traders, not beating them. Surface signals like price moves and
headlines are already priced in (the pattern gate confirmed this: 0 of 72
price patterns showed an edge).

## Ground rules (don't break these)

1. **No retroactive edits to grades.** When the grading rule changes, bump the
   version (`SCORING_VERSION` in `lib/scoring.js`, prompt/model version tags
   stored on each row) and apply it going forward. Old rows keep the grade
   they got. Rescoring history is a decision for the user, never a side effect.
2. **Never drop the kinds of calls we're bad at.** Keep predicting every
   category, horizon and coin, even ones that don't beat a coin flip.
   Cutting them would raise accuracy by changing the mix, which is dishonest.
   Save cost with Message Batches, prompt caching and model choice instead.
3. **Show weak spots honestly.** Confidence is shown as a plain,
   data-backed percentage ("N% of calls like this were right", via
   `track-record.js`). No stars or badge ratings. Hide the number when
   there's too little data.
4. **Compare against a baseline.** For prediction markets the bar is the
   crowd (always-pick-favorite), not 50%. Any "beats the crowd" number must
   be time-split and version-tagged.
5. **Minimal UI.** Dark theme, DM Sans + Syne, accent `#00e676`.

## Where things are

- Frontend: vanilla HTML/CSS/JS pages at the repo root (`home.html`,
  `feed.html`, `markets.html`, `crypto.html`, `accuracy.html`,
  `watchlist.html`, …), wrapped by `tab-shell.js`.
- API: Vercel serverless functions in `api/` (ESM). Key ones:
  `analyze.js` (stock/crypto analysis + saving predictions),
  `market-analyze.js` (Polymarket), `predictions.js` (grading + track-record
  stats), `generate-baseline.js` (daily background predictions).
- Shared logic in `lib/`: `scoring.js` (stock/crypto grading),
  `pm-resolution.js` (PM grading), `crowd-traps.js`, `pm-blend.js`,
  `anthropic.js`, `http.js` (Supabase/CORS/rate-limit helpers).
- `scripts/`: one-off diagnose/compare/regrade/fit scripts. Regrade scripts
  exist for fixing grading *bugs*, not for changing rules after the fact.
- Data: Supabase Postgres, schema + migrations in `supabase-schema.sql`.
  Auth: Clerk.
- `sentiment/`: separate Python FastAPI service (FinBERT on StockTwits),
  deployed on its own.

## Working here

- Tests: `npm test` (vitest). Build for Capacitor/Vercel: `npm run build`
  (outputs `www/`).
- The local `.env` has placeholder keys, so the production DB and real
  Anthropic calls can't be run from this machine. Say so when something
  is unverified against real data.
- Models: stock analysis on `claude-sonnet-4-6`; crypto verdicts and
  prediction markets on `claude-sonnet-5-5`; chat and display cards on Haiku.
- Pattern library: `lib/patterns.js` → history via
  `scripts/backfill-pattern-events.js` → testing gate
  `scripts/test-patterns.js --write` → `lib/pattern-registry.js`. Only
  patterns that held up on later data reach the prompt, and only after a
  person sets `PATTERNS_REVIEWED = true`.
- Two people work on this repo (the user and their partner). Pull before
  pushing and keep the partner's UI changes when rebasing.
