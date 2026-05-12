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
