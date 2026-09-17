-- Run this in your Supabase project: SQL Editor → New query → paste → Run

create table if not exists predictions (
  id             text primary key,
  created_at     timestamptz not null default now(),
  topic          text not null,
  sources        text[],
  source_grades  jsonb,
  min_grade      text,
  impact_timeframe text,
  analysis       jsonb not null,
  winner_tickers text[],
  loser_tickers  text[],
  baseline_prices jsonb,
  validation_date timestamptz,
  validated_at   timestamptz,
  actual_prices  jsonb,
  correct        boolean,
  notes          jsonb
);

create index if not exists predictions_validation_date_idx on predictions (validation_date);
create index if not exists predictions_created_at_idx      on predictions (created_at desc);
create index if not exists predictions_correct_idx         on predictions (correct);

-- Rate limiting table
create table if not exists rate_limits (
  key        text primary key,
  count      integer not null default 0,
  window_start timestamptz not null default now()
);

-- Columns added for prediction-market analysis (market-analyze.js)
alter table predictions add column if not exists type               text;
alter table predictions add column if not exists lean               text;
alter table predictions add column if not exists lean_confidence    text;
alter table predictions add column if not exists market_odds_at_time integer;
alter table predictions add column if not exists market_slug        text;
alter table predictions add column if not exists signal             text;

-- Source reputation table — tracks empirical accuracy per source over time.
-- Updated externally when predictions are validated (correct = true/false).
-- Both analyze.js and market-analyze.js read this to weight sources dynamically.
create table if not exists source_reputation (
  source   text primary key,
  attempts integer not null default 0,
  correct  integer not null default 0
);

-- Row-level security: keep predictions readable but not writable from the browser
alter table predictions      enable row level security;
alter table rate_limits      enable row level security;
alter table source_reputation enable row level security;

-- Service-role key (server-side only) bypasses RLS automatically.
-- No browser-side access needed for these tables.

-- Per-category accuracy tracking (independent score per sector/topic)
alter table predictions add column if not exists category text;
create index if not exists predictions_category_idx on predictions (category);

-- Accuracy score column: signed float -100..+100 derived from % return magnitude.
alter table predictions add column if not exists accuracy_score numeric;

-- Claim/lock columns for the ticker-based resolve pass in api/predictions.js
-- (handleResolve). Without these, two overlapping resolve runs (e.g. a slow
-- cron run overlapping the next scheduled one) could both grade the same
-- prediction and double-increment source_reputation via upsert_source_reputation.
-- 'resolving' rows older than 15 minutes are treated as stale (crashed
-- mid-run) and become reclaimable — see _claimReadyPredictions in
-- api/predictions.js.
-- status: 'pending' | 'resolving' | 'resolved' | 'failed'. 'failed' means
-- price data was unavailable for retry_count consecutive resolve passes
-- (see MAX_RESOLVE_RETRIES in api/predictions.js) — distinct from 'pending'
-- so these predictions stop being retried forever but stay visibly flagged
-- (surfaced in handleStats) rather than silently never resolving.
alter table predictions add column if not exists status text not null default 'pending';
alter table predictions add column if not exists resolving_since timestamptz;
alter table predictions add column if not exists retry_count integer not null default 0;
create index if not exists predictions_status_idx on predictions (status);

-- user_id: links predictions to Clerk user IDs (text, e.g. "user_xxx") for personal history.
-- Anonymous predictions (no token) have user_id = NULL and still count toward platform stats.
alter table predictions drop column if exists user_id;
alter table predictions add column user_id text;
create index if not exists predictions_user_id_idx on predictions (user_id);

-- IMPORTANT (manual step, not managed by this file): the watchlists, crypto_watchlists,
-- and market_watchlists tables used by api/user-watchlist.js are not defined here — they
-- must exist directly in the Supabase dashboard. Their user_id columns need the same
-- uuid -> text change applied via the Supabase SQL editor, e.g.:
--   alter table watchlists drop column if exists user_id;
--   alter table watchlists add column user_id text;
-- (repeat for crypto_watchlists, market_watchlists). Do this before deploying the
-- Clerk-based api/user-watchlist.js, or watchlist writes will fail on a type mismatch.

-- Atomic upsert for source reputation (called by resolve-predictions.js)
create or replace function upsert_source_reputation(p_source text, p_correct integer)
returns void language plpgsql security definer as $$
begin
  insert into source_reputation (source, attempts, correct)
    values (p_source, 1, p_correct)
  on conflict (source) do update
    set attempts = source_reputation.attempts + 1,
        correct  = source_reputation.correct  + p_correct;
end;
$$;

-- ── Social Sentiment tables ────────────────────────────────────────────────────
-- Managed by the Python FastAPI sentiment service; written via service-role key.
-- The Python service uses SQLAlchemy to create these; this file documents them
-- for reference and lets you pre-create them in Supabase if preferred.

create table if not exists sentiment_tweets (
  id                text primary key,
  username          text not null,
  text              text not null,
  ticker            text not null,
  timestamp         timestamptz not null,
  native_sentiment  text,            -- 'bullish' | 'bearish' | null (StockTwits tag)
  finbert_sentiment text,            -- 'positive' | 'negative' | 'neutral'
  finbert_score     numeric(5,4),    -- 0.0000 – 1.0000 confidence
  call_correct      boolean          -- null=not yet evaluated; true/false=outcome
);

create index if not exists ix_sentiment_tweets_ticker    on sentiment_tweets (ticker);
create index if not exists ix_sentiment_tweets_username  on sentiment_tweets (username);
create index if not exists ix_sentiment_tweets_ticker_ts on sentiment_tweets (ticker, timestamp desc);

create table if not exists account_scores (
  username       text primary key,
  total_calls    integer not null default 0,
  correct_calls  integer not null default 0,
  accuracy_score numeric(5,4) not null default 0,
  last_updated   timestamptz not null default now()
);

create table if not exists whitelisted_accounts (
  username       text primary key,
  accuracy_score numeric(5,4) not null,
  total_calls    integer not null,
  added_at       timestamptz not null default now()
);

-- Sentiment tables are written only by the Python service role; no browser access.
alter table sentiment_tweets      enable row level security;
alter table account_scores        enable row level security;
alter table whitelisted_accounts  enable row level security;

-- ── Source-type reward loop (prediction-markets category-aware sourcing) ──────
-- Tracks which source TYPE (e.g. "espn_stats", "lineup_data", "reddit_sentiment",
-- "sec_filing") an analysis actually cited, and whether the call went against the
-- market's own recent odds movement ("contrarian"). lib/context-graph.js aggregates
-- these per category once enough graded predictions exist, and feeds the result back
-- into future market-analyze.js prompts so source types with a real track record of
-- being right — especially on contrarian calls — get weighted more than ones that
-- don't. See lib/market-source-profiles.js for where source_type is assigned per fetcher.
alter table predictions add column if not exists source_types jsonb;
alter table predictions add column if not exists contrarian boolean;
alter table predictions add column if not exists odds_momentum_at_time jsonb;
create index if not exists predictions_market_slug_idx on predictions (market_slug);

-- coverage_volume_bucket: 'low' | 'medium' | 'high' — how many raw (pre-dedup) items
-- shared the dedupe key of whichever cited source most influenced this prediction (see
-- dedupeItems/volumeBucket in lib/market-source-profiles.js). Tracks whether leaning on
-- heavily-covered/consensus stories correlates with better or worse calls per category —
-- a widely-covered story might be well-confirmed, or might already be priced into the
-- market's odds; the reward loop (coverageVolumeAccuracy in lib/context-graph.js)
-- measures this empirically per category instead of assuming an answer.
alter table predictions add column if not exists coverage_volume_bucket text;

-- ── Live in-game sports analysis: historical situation database ───────────────
-- One row per meaningful game-state snapshot (score/period/clock), reconstructed
-- from ESPN's play-by-play + winprobability data by scripts/backfill-game-situations.js
-- (one-time historical backfill, NFL/NBA to start) and kept current by the daily
-- api/ingest-completed-games.js cron. lib/situation-similarity.js queries this with
-- tolerance bands to answer "in N historical games with a similar score/time
-- situation, how often did the trailing team come back?" — see the plan for the
-- full design. ESPN keeps full historical play-by-play indefinitely, so unlike
-- price_snapshots below this table CAN be backfilled from the past, not just
-- collected forward.
create table if not exists game_situations (
  id bigserial primary key,
  league text not null,           -- 'nfl' | 'nba'
  game_id text not null,          -- ESPN event id
  season int,
  is_playoff boolean,
  period int not null,
  seconds_remaining int not null, -- seconds remaining in the period, parsed from clock.displayValue
  home_score int not null,
  away_score int not null,
  score_diff int not null,        -- home_score - away_score, signed
  home_team text,
  away_team text,
  final_home_score int,
  final_away_score int,
  home_won boolean,               -- final outcome, joined in from header.competitions[0] once the game completed
  created_at timestamptz default now(),
  unique (game_id, period, seconds_remaining, home_score, away_score)
);
create index if not exists game_situations_lookup_idx on game_situations (league, period, score_diff, seconds_remaining);

alter table game_situations enable row level security;
-- Service-role key (server-side only, via the backfill script + ingest cron) bypasses
-- RLS automatically. No browser-side writes; reads go through lib/situation-similarity.js.

-- ── Short-horizon stock move prediction: forward-collected price snapshots ────
-- Unlike game_situations, Yahoo Finance's free intraday API only exposes ~8 days
-- of 1-minute history (confirmed live: requesting 60d at 1m granularity returns
-- a hard 422) — there is no free deep historical source to backfill from, so this
-- table starts empty and is built forward from today by api/collect-price-snapshots.js
-- polling every ~1 minute during market hours (lib/sp500-tickers.js universe,
-- via the existing crumb-authenticated batched quote pattern in api/sector-stocks.js).
-- lib/situation-similarity-stocks.js derives features (pctChange5m, relativeVolume,
-- timeOfDayBucket) from recent rows and pools across the whole tracked universe to
-- reach a usable sample size sooner than any single ticker could alone.
create table if not exists price_snapshots (
  id bigserial primary key,
  ticker text not null,
  ts timestamptz not null,
  price numeric not null,
  volume bigint,
  unique (ticker, ts)
);
create index if not exists price_snapshots_ticker_ts_idx on price_snapshots (ticker, ts desc);

alter table price_snapshots enable row level security;
-- Service-role key (server-side only, via the collector cron) bypasses RLS automatically.

-- Precomputed situation/outcome rows derived from price_snapshots, one per
-- ticker per collector run. Computed incrementally by
-- api/collect-price-snapshots.js (features at insert time, outcome_next_5m
-- filled in ~5 minutes later once it's known) specifically so
-- lib/situation-similarity-stocks.js's "find similar past situations" query
-- is a simple indexed range filter, not a self-join/table-scan over raw
-- price_snapshots — that first design was tried and found to silently break
-- (ordering bias + a row cap) once price_snapshots exceeds a few days of
-- 502-ticker, 5-minute-interval history, which happens within about a week.
create table if not exists stock_situations (
  id bigserial primary key,
  ticker text not null,
  ts timestamptz not null,
  price numeric not null,
  pct_change_5m numeric,
  pct_change_15m numeric,
  relative_volume numeric,
  time_of_day_bucket text, -- 'open' | 'midday' | 'close'
  outcome_next_5m numeric, -- null until resolved ~5 minutes later
  created_at timestamptz default now(),
  unique (ticker, ts)
);
create index if not exists stock_situations_lookup_idx on stock_situations (time_of_day_bucket, pct_change_5m) where outcome_next_5m is not null;
create index if not exists stock_situations_unresolved_idx on stock_situations (ts) where outcome_next_5m is null;

alter table stock_situations enable row level security;
-- Service-role key (server-side only, via the collector cron) bypasses RLS automatically.
