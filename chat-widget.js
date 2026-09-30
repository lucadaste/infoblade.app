(function () {
  if (document.getElementById('ii-ai-panel')) return;

  const PAGE_CONTEXTS = {
    'feed.html':        'stock-markets',
    'predictions.html': 'prediction-markets',
    'markets.html':     'prediction-markets',
    'crypto.html':      'crypto',
    'accuracy.html':    'accuracy',
  };

  const PAGE_STARTERS = {
    'stock-markets': [
      "What does impact timeframe mean?",
      "How are confidence stars calculated?",
      "What's moving markets today?",
    ],
    'prediction-markets': [
      "What does 'Contradicts market' signal mean?",
      "Why only show 20-80% odds?",
      "How do Polymarket odds work?",
    ],
    'crypto': [
      "What's moving crypto today?",
      "How does the Fear & Greed Index work?",
      "How does crypto analysis differ from stocks?",
    ],
    'accuracy': [
      "How is the accuracy % calculated?",
      "What do the A-F grades mean?",
      "How does past accuracy improve future predictions?",
    ],
  };

  const page = window.location.pathname.split('/').pop() || '';
  const pageContext = PAGE_CONTEXTS[page] || 'general';
  const starters = PAGE_STARTERS[pageContext] || [
    "How does this site work?",
    "What's the difference between the three sections?",
    "How accurate are these predictions?",
  ];

  // ── Styles ────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #ii-ai-panel {
      position: fixed;
      top: 50%;
      right: 88px;
      width: min(360px, calc(100vw - 32px));
      max-height: min(540px, calc(100vh - 80px));
      background: var(--card);
      z-index: 9998;
      display: flex;
      flex-direction: column;
      border-radius: 10px;
      border: 1px solid var(--border);
      box-shadow: 0 20px 60px rgba(0,0,0,0.7), 0 4px 16px rgba(0,0,0,0.4);
      opacity: 0;
      transform: translateY(-50%) translateX(6px) scale(0.97);
      transform-origin: center right;
      pointer-events: none;
      transition: opacity 0.18s cubic-bezier(0.4,0,0.2,1), transform 0.18s cubic-bezier(0.4,0,0.2,1);
    }
    #ii-ai-panel.ii-open {
      opacity: 1;
      transform: translateY(-50%) translateX(0) scale(1);
      pointer-events: auto;
    }

    #ii-chat-btn {
      position: fixed;
      top: 50%;
      right: 20px;
      transform: translateY(-50%);
      z-index: 9997;
      width: 54px;
      height: 54px;
      background: var(--card);
      border-radius: 50%;
      border: none;
      cursor: pointer;
      overflow: visible;
      isolation: isolate;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s;
      box-shadow: 0 4px 24px rgba(0,0,0,0.6);
    }
    #ii-chat-btn:hover { transform: translateY(-50%) scale(1.06); }

    #ii-chat-btn .ii-blade-icon {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 31px;
      height: auto;
    }
    #ii-chat-btn .ii-blade-fill {
      fill: var(--accent);
      opacity: 1;
      transition: opacity 0.15s ease;
    }
    #ii-chat-btn .ii-blade-stroke {
      fill: none;
      stroke: var(--accent);
      stroke-width: 16;
      stroke-dasharray: 6200;
      stroke-dashoffset: 6200;
      opacity: 0;
      transition: stroke-dashoffset 0.55s ease, opacity 0.1s;
    }
    #ii-chat-btn:hover .ii-blade-fill,
    #ii-chat-btn.active .ii-blade-fill { opacity: 0; }
    #ii-chat-btn:hover .ii-blade-stroke,
    #ii-chat-btn.active .ii-blade-stroke { stroke-dashoffset: 0; opacity: 1; }

    #ii-chat-btn .ii-glow-ring {
      position: absolute;
      inset: -7px;
      border-radius: 50%;
      border: 1.5px solid var(--accent);
      opacity: 0.12;
      animation: ii-breathe 5.5s ease-in-out infinite;
      pointer-events: none;
      transition: opacity 0.2s;
    }
    #ii-chat-btn:hover .ii-glow-ring,
    #ii-chat-btn.active .ii-glow-ring { animation-play-state: paused; opacity: 0.12; }
    @keyframes ii-breathe {
      0%, 100% { opacity: 0.12; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.05); }
    }

    .ii-tooltip {
      position: absolute;
      right: calc(100% + 12px);
      top: 50%;
      transform: translateY(-50%) translateX(4px);
      background: var(--ink);
      color: var(--paper);
      font-family: 'DM Sans', sans-serif;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      padding: 6px 10px;
      border-radius: 6px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s ease, transform 0.15s ease;
    }
    #ii-chat-btn:hover .ii-tooltip,
    #ii-chat-btn:focus-visible .ii-tooltip {
      opacity: 1;
      transform: translateY(-50%) translateX(0);
    }
    #ii-chat-btn.active .ii-tooltip { opacity: 0; }

    .ii-ph {
      background: var(--surface-2);
      padding: 13px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
      border-bottom: 1px solid var(--border);
      border-radius: 10px 10px 0 0;
    }
    .ii-ph-title {
      font-family: 'DM Sans', sans-serif;
      font-weight: 600;
      font-size: 13px;
      color: var(--ink);
      letter-spacing: -0.2px;
    }
    .ii-ph-title em {
      background: var(--accent);
      color: #111111;
      font-style: normal;
      padding: 1px 6px;
      margin-right: 5px;
      border-radius: 2px;
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      font-size: 11px;
      letter-spacing: 0.5px;
    }
    .ii-close {
      background: none;
      border: none;
      font-size: 20px;
      line-height: 1;
      color: var(--muted);
      cursor: pointer;
      padding: 0;
      display: flex;
      align-items: center;
      transition: color 0.15s;
    }
    .ii-close:hover { color: var(--ink); }

    .ii-msgs {
      flex: 1;
      overflow-y: auto;
      padding: 14px 14px 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      scroll-behavior: smooth;
      -webkit-overflow-scrolling: touch;
      min-height: 0;
    }
    .ii-msgs::-webkit-scrollbar { width: 3px; }
    .ii-msgs::-webkit-scrollbar-track { background: transparent; }
    .ii-msgs::-webkit-scrollbar-thumb { background: var(--divider); border-radius: 2px; }

    .ii-m {
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      max-width: 90%;
    }
    .ii-m-user {
      align-self: flex-end;
      background: var(--accent);
      color: #111111;
      padding: 8px 12px;
      border-radius: 12px 12px 3px 12px;
      font-weight: 500;
    }
    .ii-m-ai {
      align-self: flex-start;
      background: var(--paper);
      color: var(--ink);
      padding: 9px 13px;
      border-radius: 12px 12px 12px 3px;
      border: 1px solid var(--border);
    }
    .ii-m-ai strong { color: var(--ink); }
    .ii-m-thinking {
      align-self: flex-start;
      display: flex;
      align-items: center;
      gap: 7px;
      color: var(--muted);
      font-size: 12px;
      font-style: italic;
      font-family: 'DM Sans', sans-serif;
      padding: 3px 0;
    }
    .ii-dots span {
      display: inline-block;
      width: 4px; height: 4px;
      background: var(--accent);
      border-radius: 50%;
      animation: ii-bop 1.1s ease-in-out infinite;
    }
    .ii-dots span:nth-child(2) { animation-delay: 0.18s; }
    .ii-dots span:nth-child(3) { animation-delay: 0.36s; }
    @keyframes ii-bop {
      0%,80%,100% { transform: translateY(0); opacity:.3; }
      40% { transform: translateY(-4px); opacity:1; }
    }

    .ii-starters {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 2px;
    }
    .ii-sq {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 11px;
      font-family: 'DM Sans', sans-serif;
      font-size: 12px;
      color: var(--muted);
      cursor: pointer;
      text-align: left;
      line-height: 1.4;
      transition: background .15s, border-color .15s, color .15s;
    }
    .ii-sq:hover { background: rgba(0,230,118,0.08); border-color: var(--accent); color: var(--ink); }

    .ii-input-row {
      display: flex;
      gap: 8px;
      padding: 10px 12px;
      padding-bottom: max(10px, env(safe-area-inset-bottom));
      border-top: 1px solid var(--border);
      background: var(--card);
      flex-shrink: 0;
      border-radius: 0 0 10px 10px;
    }
    #ii-inp {
      flex: 1;
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 11px;
      background: var(--paper);
      color: var(--ink);
      resize: none;
      outline: none;
      line-height: 1.45;
      max-height: 80px;
      overflow-y: auto;
    }
    #ii-inp::placeholder { color: var(--muted); }
    #ii-inp:focus { border-color: var(--divider); background: var(--paper); }
    #ii-send {
      background: var(--accent);
      color: #111111;
      border: none;
      border-radius: 6px;
      padding: 0 14px;
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      font-size: 12px;
      letter-spacing: .3px;
      cursor: pointer;
      flex-shrink: 0;
      transition: opacity .15s;
    }
    #ii-send:hover { opacity: .8; }
    #ii-send:disabled { opacity: .3; cursor: not-allowed; }

    @media (max-width: 480px) {
      #ii-chat-btn { width: 48px; height: 48px; right: 14px; }
      #ii-ai-panel { right: 76px; max-height: min(480px, calc(100vh - 60px)); }
      .ii-tooltip { display: none; }
    }
  `;
  document.head.appendChild(style);

  // ── DOM ───────────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'ii-ai-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'AI Informant');
  panel.innerHTML = `
    <div class="ii-ph">
      <div class="ii-ph-title"><em>II</em> AI Informant</div>
      <button class="ii-close" id="ii-close-btn" aria-label="Close AI Informant">×</button>
    </div>
    <div class="ii-msgs" id="ii-msgs">
      <div class="ii-m ii-m-ai"><strong>Have a stock, event, or topic in mind?</strong> That's what I'm here for. Drop a ticker, a headline, or a theme and I'll break down the market implications in real time.<br><br>You can also ask me how anything on this site works, what the data means, or anything else.</div>
      <div class="ii-starters" id="ii-starters"></div>
    </div>
    <div class="ii-input-row">
      <textarea id="ii-inp" rows="1" placeholder="Ask about a stock, sector, or the site…"></textarea>
      <button id="ii-send">Send</button>
    </div>
  `;
  document.body.appendChild(panel);

  // Floating trigger button
  const floatBtn = document.createElement('button');
  floatBtn.id = 'ii-chat-btn';
  floatBtn.setAttribute('aria-label', 'AI Informant');
  floatBtn.innerHTML = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><symbol id="ii-blade" viewBox="0 0 432 466"><path fill-rule="evenodd" d="M 77 24.258 C 77 24.950, 80.019 27.537, 83.709 30.008 C 91.878 35.477, 111.820 54.509, 116.048 60.870 C 117.741 63.417, 119.639 67.408, 120.267 69.740 C 121.584 74.627, 120.561 74.165, 141.500 79.312 C 157.225 83.177, 164.663 84.355, 165.437 83.102 C 166.819 80.866, 141.659 60.509, 117 43.912 C 112.120 40.628, 78.840 23, 77.519 23 C 77.233 23, 77 23.566, 77 24.258 M 22.072 82.022 C 19.636 82.536, 17.254 83.346, 16.777 83.823 C 15.974 84.626, 18.360 85.170, 35.500 88.088 C 42.381 89.260, 52.366 91.925, 66 96.229 C 73.747 98.675, 168.701 135.953, 189 144.518 C 192.025 145.794, 199.900 148.947, 206.500 151.525 C 223.306 158.088, 242.564 168.103, 248.626 173.432 C 260.872 184.198, 263.097 193.015, 257.096 207 C 255.326 211.125, 252.754 217.200, 251.381 220.500 C 250.008 223.800, 248.027 228.525, 246.980 231 C 245.933 233.475, 242.331 242.025, 238.977 250 C 235.623 257.975, 231.478 267.755, 229.766 271.733 C 226.251 279.902, 225.973 277.689, 232.936 297 C 235.217 303.325, 240.179 317.500, 243.964 328.500 C 252.501 353.313, 258.739 370.768, 259.522 372.036 C 259.901 372.649, 244.161 373, 216.264 373 L 172.411 373 150.955 390.968 C 139.155 400.850, 129.500 409.512, 129.500 410.218 C 129.500 411.249, 143.477 411.500, 200.858 411.500 L 272.216 411.500 282.197 403 C 287.686 398.325, 294.025 393.017, 296.284 391.205 C 298.542 389.392, 302.591 385.850, 305.282 383.333 L 310.174 378.757 307.661 371.128 C 306.279 366.933, 302.370 355.625, 298.974 346 C 295.579 336.375, 289.514 319.050, 285.498 307.500 C 281.481 295.950, 277.718 285.279, 277.136 283.786 C 276.272 281.573, 276.510 280.099, 278.425 275.786 C 279.716 272.879, 283.106 264.875, 285.958 258 C 288.810 251.125, 293.333 240.325, 296.009 234 C 298.684 227.675, 303.619 215.975, 306.975 208 C 310.330 200.025, 313.943 191.475, 315.002 189 C 324.190 167.542, 326.983 160.397, 326.586 159.362 C 325.203 155.760, 292.893 138.471, 274.500 131.491 C 262.871 127.078, 226.856 116.175, 204.689 110.356 C 196.469 108.199, 170.171 103.049, 156.500 100.920 C 153.200 100.406, 145.775 98.879, 140 97.527 C 128.326 94.793, 116.390 92.763, 95.500 89.957 C 78.174 87.630, 57.967 84.449, 51.967 83.105 C 45.278 81.606, 27.153 80.949, 22.072 82.022 M 122 261.500 C 122 328.325, 122.244 383, 122.542 383 C 122.840 383, 131.278 376.134, 141.292 367.743 C 151.306 359.351, 160.730 351.529, 162.234 350.361 L 164.968 348.237 165 261.369 C 165.018 213.591, 165.025 170.155, 165.016 164.844 L 165 155.188 160.750 153.664 C 158.412 152.826, 152.900 150.737, 148.500 149.023 C 133.559 143.201, 124.621 140, 123.309 140 C 122.238 140, 122 162.065, 122 261.500"/></symbol></defs></svg><svg class="ii-blade-icon ii-blade-fill" viewBox="0 0 432 466" aria-hidden="true"><use href="#ii-blade"></use></svg><svg class="ii-blade-icon ii-blade-stroke" viewBox="0 0 432 466" aria-hidden="true"><use href="#ii-blade"></use></svg><span class="ii-glow-ring" aria-hidden="true"></span><span class="ii-tooltip" role="tooltip">AI Informant</span>`;
  floatBtn.addEventListener('click', () => window.iiToggleChat?.());
  document.body.appendChild(floatBtn);

  // Starters
  const startersEl = document.getElementById('ii-starters');
  starters.forEach(text => {
    const btn = document.createElement('button');
    btn.className = 'ii-sq';
    btn.textContent = text;
    btn.addEventListener('click', () => send(text));
    startersEl.appendChild(btn);
  });

  // ── Logic ─────────────────────────────────────────────────────────────────
  const msgsEl  = document.getElementById('ii-msgs');
  const inp     = document.getElementById('ii-inp');
  const sendBtn = document.getElementById('ii-send');
  let open = false;
  let history = [];
  let busy = false;

  function setOpen(v) {
    open = v;
    panel.classList.toggle('ii-open', open);
    const navBtn = document.getElementById('ii-chat-btn');
    if (navBtn) navBtn.classList.toggle('active', open);
  }

  document.getElementById('ii-close-btn').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) setOpen(false); });

  // Close when clicking outside the panel and trigger button.
  // Uses composedPath (the click's ancestor chain captured at dispatch time)
  // instead of panel.contains(e.target) — some in-panel clicks (e.g. a
  // starter-question chip) synchronously remove their own container as part
  // of handling the click, which detaches e.target from the document before
  // this listener runs. A detached node always fails .contains(), so the
  // click looked "outside" and closed the panel it was just opened from.
  document.addEventListener('click', e => {
    if (!open) return;
    const navBtn = document.getElementById('ii-chat-btn');
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.includes(panel) && !(navBtn && path.includes(navBtn))) {
      setOpen(false);
    }
  });

  window.iiToggleChat = () => setOpen(!open);

  function mdToHtml(raw) {
    const lines = raw.split('\n');
    const out = [];
    let inUl = false, inOl = false;

    function closeList() {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
    }

    function inline(s) {
      return s
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
        .replace(/\*((?!\*)[^*\n]+)\*/g,'<em>$1</em>');
    }

    for (const raw of lines) {
      const t = raw.trimEnd();
      if (/^### /.test(t)) {
        closeList();
        out.push(`<p style="font-weight:700;font-size:13px;margin:10px 0 2px;color:var(--ink)">${inline(t.slice(4))}</p>`);
      } else if (/^## /.test(t)) {
        closeList();
        out.push(`<p style="font-weight:700;font-size:13.5px;margin:12px 0 2px;color:var(--ink)">${inline(t.slice(3))}</p>`);
      } else if (/^# /.test(t)) {
        closeList();
        out.push(`<p style="font-weight:700;font-size:14px;margin:14px 0 4px;color:var(--ink)">${inline(t.slice(2))}</p>`);
      } else if (/^[-*•] /.test(t)) {
        if (inOl) { out.push('</ol>'); inOl = false; }
        if (!inUl) { out.push('<ul style="padding-left:18px;margin:4px 0;display:flex;flex-direction:column;gap:3px">'); inUl = true; }
        out.push(`<li>${inline(t.replace(/^[-*•] /,''))}</li>`);
      } else if (/^\d+\. /.test(t)) {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (!inOl) { out.push('<ol style="padding-left:18px;margin:4px 0;display:flex;flex-direction:column;gap:3px">'); inOl = true; }
        out.push(`<li>${inline(t.replace(/^\d+\. /,''))}</li>`);
      } else if (t.trim() === '') {
        closeList();
        out.push('<div style="height:5px"></div>');
      } else {
        closeList();
        out.push(`<p style="margin:0">${inline(t)}</p>`);
      }
    }
    closeList();
    return `<div style="display:flex;flex-direction:column;gap:4px">${out.join('')}</div>`;
  }

  function addMsg(role, text) {
    const d = document.createElement('div');
    d.className = 'ii-m ' + (role === 'user' ? 'ii-m-user' : 'ii-m-ai');
    if (role === 'user') {
      d.textContent = text;
    } else {
      d.innerHTML = mdToHtml(text);
    }
    msgsEl.appendChild(d);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return d;
  }

  function addThinking() {
    const d = document.createElement('div');
    d.className = 'ii-m-thinking';
    d.innerHTML = `<span class="ii-dots"><span></span><span></span><span></span></span> Thinking…`;
    msgsEl.appendChild(d);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return d;
  }

  async function send(text) {
    text = (text || inp.value).trim();
    if (!text || busy) return;

    startersEl.remove();
    inp.value = '';
    inp.style.height = 'auto';
    addMsg('user', text);

    // Auth gate — require sign-in
    const token = await window._auth?.getToken();
    if (!token) {
      addMsg('assistant', '**AI Informant requires an infoblade account.**\n\nCreating a free profile takes about 10 seconds — click the account icon in the top-right corner to get started.');
      return;
    }

    busy = true;
    sendBtn.disabled = true;

    history.push({ role: 'user', content: text });

    const thinking = addThinking();
    try {
      const res = await fetch(window.API_BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ messages: history, pageContext }),
        signal: AbortSignal.timeout(35000)
      });
      thinking.remove();
      const data = await res.json();
      const reply = data.reply || data.error || 'Something went wrong. Try again.';
      addMsg('assistant', reply);
      history.push({ role: 'assistant', content: reply });
    } catch (e) {
      thinking.remove();
      addMsg('assistant', e.name === 'TimeoutError'
        ? 'The request timed out. Please try again.'
        : 'Connection error. Please try again.');
    }
    busy = false;
    sendBtn.disabled = false;
    inp.focus();
  }

  sendBtn.addEventListener('click', () => send());
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inp.addEventListener('input', () => {
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 80) + 'px';
  });
})();
