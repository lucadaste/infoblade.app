// The analysis prompts (api/analyze.js runAnalysis, api/market-analyze.js
// runMarketAnalysis) send their fixed rules as a cached system prefix and the
// per-request data in the user turn. Saved on each prediction as
// analysis.prompt_layout so graded accuracy can be compared across layouts —
// rows without it were generated with the old single-prompt layout (data
// first, rules after). Bump when the prompt structure changes.
export const PROMPT_LAYOUT_VERSION = 'cached-system-v1';

// 1-hour TTL: the baseline cron (api/generate-baseline.js) runs every 30
// minutes, so each run's reads keep the entry warm; a 5-minute entry would
// expire between runs and pay the write premium every time.
export const CACHE_1H = { type: 'ephemeral', ttl: '1h' };

// One line per call in the function logs, to confirm the prefix is actually
// being cached (cache_read > 0 after the first call of a run).
export function logCacheUsage(label, usage) {
  if (!usage) return;
  console.log(`[${label}] tokens`, {
    input: usage.input_tokens,
    cache_read: usage.cache_read_input_tokens || 0,
    cache_write: usage.cache_creation_input_tokens || 0,
    output: usage.output_tokens,
  });
}
