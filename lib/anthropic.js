// Thin raw-HTTP helpers for the Claude Messages and Message Batches APIs,
// shared by api/analyze.js, api/market-analyze.js and the baseline generator.
// The analysis pipelines build a Messages request body once (prepare step);
// it is sent either directly (user requests) or inside a batch (background
// baseline predictions, billed at 50% — see api/generate-baseline.js).

const API = 'https://api.anthropic.com/v1';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function _headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01',
    ...extra,
  };
}

// One Messages call. Bodies that ask for server-side refusal fallbacks need
// the matching beta header.
export async function callMessages(body, { timeoutMs = 55000 } = {}) {
  const res = await fetch(`${API}/messages`, {
    method: 'POST',
    headers: _headers(body.fallbacks ? { 'anthropic-beta': FALLBACK_BETA } : {}),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

// The Batches API rejects `fallbacks`; a refused item simply comes back with
// stop_reason "refusal" and the finish step skips it.
export function toBatchParams(body) {
  const { fallbacks: _omit, ...params } = body;
  return params;
}

// requests: [{ custom_id, params }] — custom_id must be unique within the
// batch, 1-64 chars of [a-zA-Z0-9_-].
export async function submitBatch(requests) {
  const res = await fetch(`${API}/messages/batches`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`batch submit failed: ${data.error?.message || res.status}`);
  return data; // { id, processing_status, ... }
}

export async function getBatch(id) {
  const res = await fetch(`${API}/messages/batches/${encodeURIComponent(id)}`, {
    headers: _headers(),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`batch status failed: ${data.error?.message || res.status}`);
  return data; // { id, processing_status: 'in_progress'|'canceling'|'ended', results_url, ... }
}

// Results are JSONL in no particular order: one { custom_id, result } per line,
// result.type 'succeeded' (with .message) | 'errored' | 'canceled' | 'expired'.
export function parseBatchResults(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row?.custom_id) out.push(row);
    } catch (_) { /* skip a malformed line rather than lose the rest */ }
  }
  return out;
}

export async function fetchBatchResults(resultsUrl) {
  const res = await fetch(resultsUrl, { headers: _headers(), signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`batch results failed: ${res.status}`);
  return parseBatchResults(await res.text());
}
