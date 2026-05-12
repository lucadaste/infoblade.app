# API — `analyze.js`

Serverless handler for fetching, grouping, and deeply analyzing financial news. Powers the main analysis flow on investmentinformatics.ai.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Supabase service role key (not anon) |
| `ANTHROPIC_KEY` | Yes | Anthropic API key |
| `ALLOWED_ORIGIN` | No | CORS allowed origin (defaults to `https://investmentinformatics.ai`) |

---

## `GET /api/analyze`

Fetches financial news from RSS feeds (Reuters, CNBC, WSJ, MarketWatch, etc.) and Google News, deduplicates them, then uses Claude to group headlines into distinct market events and rank them by US market impact.

### Query Parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `category` | string | `any` | News category filter. Options: `any`, `macro`, `energy`, `technology`, `financials`, `precious-metals`, `real-estate`, `crypto`, `consumer`, `healthcare`, `defense` |
| `timeframe` | string | `any` | Recency filter. Options: `any`, `today`, `3days`, `7days` |
| `minGrade` | string | `medium` | Minimum source quality threshold. Options: `all`, `low`, `medium`, `high` |

### Response

```json
{
  "groups": [
    {
      "topic": "Fed signals pause on rate cuts amid sticky inflation",
      "sources": ["Reuters", "CNBC", "The Wall Street Journal"],
      "sourceGrades": { "Reuters": "High", "CNBC": "High", "The Wall Street Journal": "High" },
      "totalSources": 7,
      "headlines": ["Fed holds rates...", "Powell signals..."],
      "dates": ["Mon, 12 May 2025 14:00:00 GMT"]
    }
  ]
}
```

### Rate Limit
10 requests per minute per IP.

---

## `POST /api/analyze`

Runs a deep Goldman Sachs-style analysis on a specific market topic. Fetches live Polymarket prediction market odds for calibration, fetches baseline stock prices for future validation, and persists a prediction record to Supabase.

### Request Body

```json
{
  "topic": "Fed signals pause on rate cuts",
  "headlines": ["Headline 1", "Headline 2"],
  "sources": ["Reuters", "CNBC"],
  "sourceGrades": { "Reuters": "High", "CNBC": "High" },
  "minGrade": "medium",
  "impactTimeframe": "Over the next 2-4 weeks"
}
```

| Field | Required | Description |
|---|---|---|
| `topic` | Yes | The market event topic (max 300 chars) |
| `headlines` | No | Array of headline strings (max 40 items, 500 chars each) |
| `sources` | No | Array of source names (max 40 items) |
| `sourceGrades` | No | Map of source name → grade override |
| `minGrade` | No | Minimum grade for sources included in analysis (`all`, `low`, `medium`, `high`) |
| `impactTimeframe` | No | Natural language timeframe string, e.g. `"2-4 weeks"` |

### Response

```json
{
  "why_it_matters": "...",
  "impact_timeframe": "Over the next 2-4 weeks",
  "crowd_summary": "...",
  "sectors": {
    "positive": ["Technology"],
    "negative": ["Utilities"],
    "neutral": ["Energy"]
  },
  "winners": {
    "explanation": "...",
    "tickers": ["NVDA", "MSFT"]
  },
  "losers": {
    "explanation": "...",
    "tickers": ["TLT"]
  },
  "confidence": "4 — strong multi-source consensus with corroborating macro data",
  "predictionId": "pred_1747084800000_3421"
}
```

### Rate Limit
20 requests per minute per IP.

---

## Source Quality Grading

Sources are assigned a grade used to weight their influence on the consensus summary and confidence score.

| Grade | Weight | Examples |
|---|---|---|
| High | 1.0 | Reuters, AP, Bloomberg, WSJ, Financial Times, BBC, CNBC |
| Medium | 0.7 | CNBC, MarketWatch, Yahoo Finance, CNN, Forbes, Axios |
| Low | 0.4 | Fox News, ZeroHedge, Daily Mail, NY Post |
| Unknown | 0.2 | Any source not in the quality map |

Sources with 30+ tracked predictions have their weight dynamically adjusted based on historical accuracy (±50% multiplier, ramped in linearly over the first 60 predictions).

---

## Supabase Tables Used

| Table | Operation | Description |
|---|---|---|
| `rate_limits` | read/upsert/update | Per-IP sliding window counters (1-minute windows) |
| `predictions` | insert | Saves POST analysis results for future accuracy validation |
