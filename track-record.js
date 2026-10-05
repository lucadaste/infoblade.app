// Track record in place of a confidence score: "64% of calls like this were
// right". The number is the real hit rate of past graded calls in the same
// section at the same internal confidence level (api/predictions.js
// ?track-record), narrowed to the same horizon (short = up to a week) when
// that bucket has enough history. Buckets with too little data come back
// with hitRate null and are hidden rather than guessed.
//
// Usage: put TrackRecord.slot(level, section, horizon) in your HTML, then call
// TrackRecord.fill(container). Slots rendered before the data arrives are
// filled in when it does.
(function () {
  let data = null;

  function fill(root) {
    if (!data) return;
    (root || document).querySelectorAll('.track-record-slot:not([data-filled])').forEach(el => {
      el.dataset.filled = '1';
      const level = data[el.dataset.section]?.[el.dataset.level];
      const byH = el.dataset.horizon ? level?.byHorizon?.[el.dataset.horizon] : null;
      const b = byH?.hitRate != null ? byH : level;
      const row = el.closest('.chain-row, .track-record-row');
      if (!b || b.hitRate == null) { if (row) row.style.display = 'none'; else el.remove(); return; }
      el.innerHTML = `<span class="track-record" data-tip="Based on ${b.n} past calls like this that have already been checked">${b.hitRate}%</span><span class="track-record-sub">of calls like this were right</span>`;
    });
  }

  fetch((window.API_BASE || '') + '/api/predictions?track-record=true')
    .then(r => (r.ok ? r.json() : null))
    .then(d => { data = d?.sections || {}; fill(); })
    .catch(() => { data = {}; fill(); });

  // Claude's confidence comes back as "4 — reason"; only the reason is shown.
  function reasonText(conf) {
    return String(conf || '').replace(/^\s*[1-5]\s*(?:\/\s*5)?\s*[—–-]?\s*/, '').trim();
  }

  // Internal 1-5 level from the same string (defaults to 3, like lib/confidence.js).
  function level(conf) {
    const m = String(conf || '').match(/^\s*([1-5])/);
    return m ? parseInt(m[1], 10) : 3;
  }

  // 'short' (up to a week) or 'long' from a timeframe like "1 day", "7 days",
  // "Immediate within 48 hours" or "Over the next 2-4 weeks"; null if unknown.
  function horizonOf(text) {
    const m = String(text || '').toLowerCase().match(/(\d+(?:\.\d+)?)\s*(?:-\s*\d+\s*)?(hour|hr|day|week|wk|month|mo|year|yr)/);
    if (!m) return /immediate|today|tomorrow|24h/.test(String(text).toLowerCase()) ? 'short' : null;
    const perUnit = { hour: 1 / 24, hr: 1 / 24, day: 1, week: 7, wk: 7, month: 30, mo: 30, year: 365, yr: 365 };
    return parseFloat(m[1]) * perUnit[m[2]] <= 7.5 ? 'short' : 'long';
  }

  function slot(lvl, section, horizon) {
    return `<span class="track-record-slot" data-level="${lvl}" data-section="${section || 'stocks'}"${horizon ? ` data-horizon="${horizon}"` : ''}></span>`;
  }

  window.TrackRecord = { slot, fill, reasonText, level, horizonOf };
})();
