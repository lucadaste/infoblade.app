(function () {
  'use strict';
  if (document.getElementById('sw-card')) return;

  // ── Config ────────────────────────────────────────────────────────────────
  const API = (window.SENTIMENT_API_URL || '').replace(/\/$/, '');
  const REFRESH_MS  = 15 * 60 * 1000;   // 15-minute auto-refresh
  const TICKERS     = ['AAPL','TSLA','NVDA','MSFT','AMZN','GOOGL','META','AMD','NFLX','JPM','SPY','QQQ'];

  // ── State ─────────────────────────────────────────────────────────────────
  let currentTicker  = 'AAPL';
  let refreshTimer   = null;
  let lastUpdated    = null;
  let clockTimer     = null;

  // ── Inject styles ─────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #sw-card {
      background: #0a0a0a;
      border-radius: 12px;
      padding: 28px 32px 22px;
      border: 1px solid #1e1e1e;
      margin-bottom: 24px;
      font-family: 'DM Sans', sans-serif;
    }
    .sw-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 22px;
      flex-wrap: wrap;
    }
    .sw-title-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .sw-section-label {
      font-family: 'Share Tech Mono', monospace;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #888;
    }
    .sw-beta {
      font-family: 'Share Tech Mono', monospace;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      background: rgba(0,230,118,0.12);
      color: #00e676;
      border: 1px solid rgba(0,230,118,0.25);
      padding: 2px 6px;
      border-radius: 3px;
    }
    .sw-header-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .sw-ticker-input {
      font-family: 'Share Tech Mono', monospace;
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      color: #e8e6e0;
      background: #161616;
      border: 1px solid #2a2a2a;
      border-radius: 4px;
      padding: 6px 10px;
      width: 80px;
      outline: none;
      letter-spacing: 0.5px;
      transition: border-color 0.15s;
    }
    .sw-ticker-input:focus { border-color: #00e676; }
    .sw-refresh-btn {
      background: none;
      border: none;
      color: #555;
      cursor: pointer;
      padding: 4px;
      line-height: 1;
      font-size: 15px;
      transition: color 0.15s, transform 0.3s;
      display: flex;
      align-items: center;
    }
    .sw-refresh-btn:hover { color: #888; }
    .sw-refresh-btn.spinning { animation: sw-spin 0.7s linear 1; color: #00e676; }
    @keyframes sw-spin { to { transform: rotate(360deg); } }
    .sw-updated {
      font-size: 11px;
      color: #444;
      white-space: nowrap;
      font-family: 'DM Sans', sans-serif;
    }
    /* ── Body ── */
    .sw-body {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 28px;
      align-items: start;
    }
    @media (max-width: 600px) {
      .sw-body { grid-template-columns: 1fr; gap: 20px; }
      #sw-card { padding: 20px 18px 16px; }
    }
    /* ── Signal ── */
    .sw-signal-badge {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-family: 'Share Tech Mono', monospace;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 14px;
    }
    .sw-signal-badge::before {
      content: '';
      display: inline-block;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .sw-sig-bullish { color: #00e676; }
    .sw-sig-bullish::before { background: #00e676; box-shadow: 0 0 0 0 rgba(0,230,118,.75); animation: sw-dot-pulse 2s ease-out infinite; }
    .sw-sig-bearish { color: #ff5252; }
    .sw-sig-bearish::before { background: #ff5252; }
    .sw-sig-neutral  { color: #888; }
    .sw-sig-neutral::before  { background: #555; }
    @keyframes sw-dot-pulse {
      0%   { box-shadow: 0 0 0 0   rgba(0,230,118,.75); }
      70%  { box-shadow: 0 0 0 10px rgba(0,230,118,0); }
      100% { box-shadow: 0 0 0 0   rgba(0,230,118,0); }
    }
    /* ── Confidence bar ── */
    .sw-conf-track {
      height: 5px;
      background: #1e1e1e;
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 8px;
      max-width: 360px;
    }
    .sw-conf-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.6s cubic-bezier(0.4,0,0.2,1), background 0.3s;
    }
    .sw-conf-fill-bullish { background: #00e676; }
    .sw-conf-fill-bearish { background: #ff5252; }
    .sw-conf-fill-neutral  { background: #555; }
    .sw-conf-meta {
      display: flex;
      gap: 14px;
      font-size: 12px;
      color: #666;
    }
    .sw-conf-pct { color: #aaa; font-weight: 500; }
    /* ── Accounts ── */
    .sw-accounts-wrap {
      min-width: 200px;
      max-width: 260px;
    }
    @media (max-width: 600px) { .sw-accounts-wrap { max-width: 100%; min-width: unset; } }
    .sw-accounts-label {
      font-family: 'Share Tech Mono', monospace;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #444;
      margin-bottom: 10px;
    }
    .sw-account-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      border-bottom: 1px solid #161616;
    }
    .sw-account-row:last-child { border-bottom: none; }
    .sw-acct-name {
      font-family: 'Share Tech Mono', monospace;
      font-size: 11px;
      color: #c8c6c0;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sw-acct-acc {
      font-size: 10px;
      color: #555;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .sw-acct-dir {
      font-family: 'Share Tech Mono', monospace;
      font-size: 11px;
      font-weight: 700;
      flex-shrink: 0;
      width: 18px;
      text-align: center;
    }
    .sw-acct-dir-bullish { color: #00e676; }
    .sw-acct-dir-bearish { color: #ff5252; }
    .sw-acct-dir-neutral  { color: #555; }
    /* ── Disclaimer ── */
    .sw-disclaimer {
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid #1a1a1a;
      font-size: 11px;
      color: #444;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    /* ── Skeleton loading ── */
    .sw-skel {
      background: linear-gradient(90deg, #141414 25%, #1e1e1e 50%, #141414 75%);
      background-size: 200% 100%;
      animation: sw-shimmer 1.5s ease-in-out infinite;
      border-radius: 4px;
    }
    @keyframes sw-shimmer {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    /* ── Empty / error ── */
    .sw-empty {
      color: #444;
      font-size: 13px;
      padding: 12px 0 4px;
      line-height: 1.6;
    }
    .sw-error { color: #c84040; }
  `;
  document.head.appendChild(style);

  // ── Mount point ───────────────────────────────────────────────────────────
  const card = document.createElement('div');
  card.id = 'sw-card';

  // Inject before the first market/feed grid, falling back to the body
  const anchor = document.querySelector('.market-grid, .feed-container, .predictions-list, main');
  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(card, anchor);
  } else {
    document.body.appendChild(card);
  }

  // ── Initial render ────────────────────────────────────────────────────────
  function renderSkeleton() {
    card.innerHTML = `
      <div class="sw-header">
        <div class="sw-title-group">
          <span class="sw-section-label">SOCIAL SENTIMENT</span>
          <span class="sw-beta">BETA</span>
        </div>
        <div class="sw-header-right">
          ${tickerInputHTML()}
          <button class="sw-refresh-btn" id="sw-refresh-btn" title="Refresh now">↺</button>
          <span class="sw-updated" id="sw-updated"></span>
        </div>
      </div>
      <div class="sw-body">
        <div>
          <div class="sw-skel" style="width:140px;height:26px;margin-bottom:14px"></div>
          <div class="sw-skel" style="width:280px;height:5px;margin-bottom:8px"></div>
          <div class="sw-skel" style="width:180px;height:14px"></div>
        </div>
        <div class="sw-accounts-wrap">
          <div class="sw-skel" style="width:120px;height:10px;margin-bottom:10px"></div>
          ${[1,2,3].map(() => `<div class="sw-skel" style="width:200px;height:16px;margin-bottom:8px"></div>`).join('')}
        </div>
      </div>
      <div class="sw-disclaimer">Social sentiment is not financial advice.</div>
    `;
    bindControls();
  }

  function renderData(data) {
    const signal    = data.signal   || 'neutral';
    const conf      = data.confidence ?? 0;
    const pct       = Math.round(conf * 100);
    const count     = data.post_count ?? 0;
    const window_h  = data.window_hours ?? 48;
    const accounts  = data.top_accounts ?? [];
    const message   = data.message || '';

    const dirMap = { bullish: '↑', bearish: '↓', neutral: '→' };
    const labelMap = { bullish: 'BULLISH', bearish: 'BEARISH', neutral: 'NEUTRAL' };

    const accountRows = accounts.length
      ? accounts.map(a => `
          <div class="sw-account-row">
            <span class="sw-acct-name">@${_esc(a.username)}</span>
            <span class="sw-acct-acc">${Math.round((a.accuracy_score || 0) * 100)}% acc</span>
            <span class="sw-acct-dir sw-acct-dir-${a.sentiment}">${dirMap[a.sentiment] || '→'}</span>
          </div>`).join('')
      : `<div class="sw-empty">${message || 'No trusted accounts have posted about this ticker in the last ${window_h}h.'}</div>`;

    const bodyContent = count > 0 ? `
      <div>
        <div class="sw-signal-badge sw-sig-${signal}">${labelMap[signal]}</div>
        <div class="sw-conf-track">
          <div class="sw-conf-fill sw-conf-fill-${signal}" style="width:${pct}%"></div>
        </div>
        <div class="sw-conf-meta">
          <span class="sw-conf-pct">${pct}% confidence</span>
          <span>${count} post${count !== 1 ? 's' : ''} · ${window_h}h</span>
        </div>
      </div>
      <div class="sw-accounts-wrap">
        <div class="sw-accounts-label">TOP TRUSTED ACCOUNTS</div>
        ${accountRows}
      </div>` : `
      <div class="sw-empty" style="grid-column:1/-1">
        ${message || `No scored posts from trusted accounts for <strong style="color:#e8e6e0">${_esc(currentTicker)}</strong> in the last ${window_h}h. The whitelist is building as the scorer collects data.`}
      </div>`;

    card.innerHTML = `
      <div class="sw-header">
        <div class="sw-title-group">
          <span class="sw-section-label">SOCIAL SENTIMENT</span>
          <span class="sw-beta">BETA</span>
        </div>
        <div class="sw-header-right">
          ${tickerInputHTML()}
          <button class="sw-refresh-btn" id="sw-refresh-btn" title="Refresh now">↺</button>
          <span class="sw-updated" id="sw-updated">updated just now</span>
        </div>
      </div>
      <div class="sw-body">${bodyContent}</div>
      <div class="sw-disclaimer">Social sentiment is not financial advice.</div>
    `;
    bindControls();
  }

  function renderError(msg) {
    card.innerHTML = `
      <div class="sw-header">
        <div class="sw-title-group">
          <span class="sw-section-label">SOCIAL SENTIMENT</span>
          <span class="sw-beta">BETA</span>
        </div>
        <div class="sw-header-right">
          ${tickerInputHTML()}
          <button class="sw-refresh-btn" id="sw-refresh-btn" title="Retry">↺</button>
          <span class="sw-updated" id="sw-updated"></span>
        </div>
      </div>
      <div class="sw-body">
        <div class="sw-empty sw-error" style="grid-column:1/-1">${_esc(msg)}</div>
      </div>
      <div class="sw-disclaimer">Social sentiment is not financial advice.</div>
    `;
    bindControls();
  }

  // ── Fetch & refresh ───────────────────────────────────────────────────────
  async function load(ticker) {
    if (!API) {
      renderError('Sentiment service URL not configured. Set window.SENTIMENT_API_URL before loading this widget.');
      return;
    }
    renderSkeleton();
    try {
      const res = await fetch(
        `${API}/api/sentiment?ticker=${encodeURIComponent(ticker)}`,
        { signal: AbortSignal.timeout(12000) }
      );
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json();
      lastUpdated = Date.now();
      renderData(data);
      startClock();
    } catch (err) {
      const msg = err.name === 'TimeoutError'
        ? 'Request timed out — sentiment service may be starting up.'
        : `Could not load sentiment data: ${err.message}`;
      renderError(msg);
    }
    scheduleRefresh();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => load(currentTicker), REFRESH_MS);
  }

  function startClock() {
    clearInterval(clockTimer);
    clockTimer = setInterval(() => {
      const el = document.getElementById('sw-updated');
      if (!el || !lastUpdated) return;
      const age = Math.floor((Date.now() - lastUpdated) / 60000);
      el.textContent = age < 1 ? 'updated just now' : `updated ${age}m ago`;
    }, 30000);
  }

  // ── Control binding (called after each render) ────────────────────────────
  function bindControls() {
    const input      = card.querySelector('.sw-ticker-input');
    const refreshBtn = card.getElementById ? null : card.querySelector('#sw-refresh-btn');
    const rBtn       = document.getElementById('sw-refresh-btn');

    if (input) {
      input.value = currentTicker;
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          const t = input.value.trim().toUpperCase();
          if (t && /^[A-Z.]{1,10}$/.test(t)) {
            currentTicker = t;
            load(currentTicker);
          }
        }
      });
      input.addEventListener('blur', () => {
        const t = input.value.trim().toUpperCase();
        if (t && /^[A-Z.]{1,10}$/.test(t) && t !== currentTicker) {
          currentTicker = t;
          load(currentTicker);
        }
      });
    }

    if (rBtn) {
      rBtn.addEventListener('click', () => {
        rBtn.classList.add('spinning');
        rBtn.addEventListener('animationend', () => rBtn.classList.remove('spinning'), { once: true });
        clearTimeout(refreshTimer);
        load(currentTicker);
      });
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function tickerInputHTML() {
    const opts = TICKERS.map(t => `<option value="${t}">`).join('');
    return `
      <input class="sw-ticker-input" list="sw-tickers-list"
             value="${_esc(currentTicker)}" maxlength="10"
             autocomplete="off" spellcheck="false" placeholder="AAPL">
      <datalist id="sw-tickers-list">${opts}</datalist>`;
  }

  function _esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    clearTimeout(refreshTimer);
    clearInterval(clockTimer);
  });

  load(currentTicker);
})();
