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
      "What does the hit rate mean?",
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
      bottom: 214px;
      right: 16px;
      width: min(460px, calc(100vw - 32px));
      max-height: min(620px, calc(100vh - 238px));
      background: var(--card);
      z-index: 9998;
      display: flex;
      flex-direction: column;
      border-radius: 10px;
      border: 1px solid var(--border);
      box-shadow: 0 12px 36px rgba(0,0,0,0.4);
      opacity: 0;
      transform: translateY(8px) scale(0.97);
      transform-origin: bottom right;
      pointer-events: none;
      transition: opacity 0.18s cubic-bezier(0.4,0,0.2,1), transform 0.18s cubic-bezier(0.4,0,0.2,1);
    }
    #ii-ai-panel.ii-open {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }

    #ii-chat-btn {
      position: fixed;
      bottom: 148px;
      right: 16px;
      z-index: 9997;
      width: 56px;
      height: 56px;
      background: var(--card);
      border-radius: 50%;
      border: none;
      cursor: pointer;
      overflow: visible;
      isolation: isolate;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, opacity 0.2s;
      box-shadow: 0 3px 14px rgba(0,0,0,0.35);
    }
    #ii-chat-btn:hover { transform: scale(1.06); }
    #ii-chat-btn.ii-hidden {
      opacity: 0;
      transform: scale(0.5);
      pointer-events: none;
    }

    #ii-chat-btn .ii-blade-icon {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 32px;
      height: auto;
      fill: var(--accent);
    }

    #ii-chat-btn .ii-sweep {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      pointer-events: none;
      background: linear-gradient(115deg, transparent 40%, rgba(0,230,118,0.55) 50%, transparent 60%);
      background-size: 280% 100%;
      background-position: 140% 0;
      opacity: 0;
      animation: ii-ignite-loop 5s ease-out infinite;
    }
    #ii-chat-btn.active .ii-sweep { animation-play-state: paused; opacity: 0; }
    @keyframes ii-ignite-loop {
      0%, 100% { background-position: 140% 0; opacity: 0; }
      3% { opacity: 0.9; }
      12% { background-position: -40% 0; opacity: 0; }
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

    .ii-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      align-self: flex-start;
      max-width: 92%;
    }
    .ii-row .ii-m-ai { max-width: none; min-width: 0; }
    .ii-avatar {
      width: 28px;
      height: 28px;
      fill: var(--accent);
      transform-origin: center;
      display: block;
    }
    .ii-row-avatar {
      flex-shrink: 0;
      margin-top: 2px;
      pointer-events: none;
    }
    .ii-avatar-busy { animation: ii-avatar-pulse 1.3s ease-in-out infinite; }
    @keyframes ii-avatar-pulse {
      0%, 100% { transform: scale(1); opacity: 0.8; filter: drop-shadow(0 0 0 rgba(0,230,118,0)); }
      50% { transform: scale(1.2); opacity: 1; filter: drop-shadow(0 0 7px rgba(0,230,118,0.65)); }
    }
    .ii-thinking-dots { display: inline-flex; align-items: center; gap: 3px; margin-left: 2px; }
    .ii-thinking-dots span {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.25;
      animation: ii-dot-pulse 1.1s ease-in-out infinite;
    }
    .ii-thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
    .ii-thinking-dots span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes ii-dot-pulse {
      0%, 60%, 100% { opacity: 0.25; transform: scale(0.8); }
      30% { opacity: 1; transform: scale(1); }
    }
    .ii-close-float {
      position: absolute;
      top: 12px;
      right: 12px;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--surface-2);
      border: 1px solid var(--border);
      font-size: 16px;
      line-height: 1;
      color: var(--muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2;
      transition: color 0.15s, background 0.15s;
    }
    .ii-close-float:hover { color: var(--ink); background: var(--card); }

    .ii-msgs {
      position: relative;
      flex: 1;
      overflow-y: auto;
      padding: 48px 22px 14px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      scroll-behavior: smooth;
      -webkit-overflow-scrolling: touch;
      min-height: 0;
    }
    .ii-msgs::-webkit-scrollbar { width: 3px; }
    .ii-msgs::-webkit-scrollbar-track { background: transparent; }
    .ii-msgs::-webkit-scrollbar-thumb { background: var(--divider); border-radius: 2px; }

    .ii-m {
      font-family: 'DM Sans', sans-serif;
      font-size: 14.5px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      max-width: 92%;
    }
    .ii-m-user {
      align-self: flex-end;
      color: var(--ink);
      font-weight: 600;
      text-align: right;
    }
    .ii-m-ai {
      align-self: flex-start;
      color: var(--ink);
    }
    .ii-m-ai strong { color: var(--ink); }
    .ii-m-thinking {
      color: var(--muted);
      font-size: 13.5px;
      font-family: 'DM Sans', sans-serif;
      padding-top: 3px;
      padding-bottom: 3px;
    }

    .ii-starters {
      display: flex;
      flex-direction: column;
      gap: 7px;
      margin-top: 2px;
    }
    .ii-sq {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 9px 12px;
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      color: var(--muted);
      cursor: pointer;
      text-align: left;
      line-height: 1.4;
      transition: background .15s, border-color .15s, color .15s;
    }
    .ii-sq:hover { background: rgba(0,230,118,0.08); border-color: var(--accent); color: var(--ink); }

    .ii-input-row {
      display: flex;
      gap: 9px;
      padding: 14px 18px;
      padding-bottom: max(14px, env(safe-area-inset-bottom));
      border-top: 1px solid var(--border);
      background: var(--card);
      flex-shrink: 0;
      border-radius: 0 0 10px 10px;
    }
    #ii-inp {
      flex: 1;
      font-family: 'DM Sans', sans-serif;
      font-size: 14px;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 9px 12px;
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
      border-radius: 7px;
      padding: 0 16px;
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      font-size: 13px;
      letter-spacing: .3px;
      cursor: pointer;
      flex-shrink: 0;
      transition: opacity .15s;
    }
    #ii-send:hover { opacity: .8; }
    #ii-send:disabled { opacity: .3; cursor: not-allowed; }

    @media (max-width: 480px) {
      #ii-chat-btn { width: 50px; height: 50px; bottom: 148px; }
      #ii-ai-panel { bottom: 208px; max-height: min(480px, calc(100vh - 232px)); }
      .ii-tooltip { display: none; }
    }

    @media (min-width: 1024px) {
      #ii-chat-btn { bottom: 154px; }
      #ii-ai-panel { bottom: 220px; width: min(500px, calc(100vw - 32px)); max-height: min(660px, calc(100vh - 244px)); }
    }

    /* Wide desktops have real leftover space beside the page content — dock
       the panel to the right edge, nearly full height, instead of leaving it
       a small bottom-right popup. */
    @media (min-width: 1440px) {
      #ii-ai-panel {
        top: 92px;
        bottom: 16px;
        right: 16px;
        width: 520px;
        max-height: none;
        transform: translateX(14px) scale(0.99);
        transform-origin: right center;
      }
      #ii-ai-panel.ii-open { transform: translateX(0) scale(1); }
    }
  `;
  document.head.appendChild(style);

  // ── DOM ───────────────────────────────────────────────────────────────────
  const bladeDefs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  bladeDefs.setAttribute('width', '0');
  bladeDefs.setAttribute('height', '0');
  bladeDefs.setAttribute('style', 'position:absolute');
  bladeDefs.setAttribute('aria-hidden', 'true');
  bladeDefs.innerHTML = `<defs><symbol id="ii-blade" viewBox="0 0 432 466"><path fill-rule="evenodd" d="M 77 24.258 C 77 24.950, 80.019 27.537, 83.709 30.008 C 91.878 35.477, 111.820 54.509, 116.048 60.870 C 117.741 63.417, 119.639 67.408, 120.267 69.740 C 121.584 74.627, 120.561 74.165, 141.500 79.312 C 157.225 83.177, 164.663 84.355, 165.437 83.102 C 166.819 80.866, 141.659 60.509, 117 43.912 C 112.120 40.628, 78.840 23, 77.519 23 C 77.233 23, 77 23.566, 77 24.258 M 22.072 82.022 C 19.636 82.536, 17.254 83.346, 16.777 83.823 C 15.974 84.626, 18.360 85.170, 35.500 88.088 C 42.381 89.260, 52.366 91.925, 66 96.229 C 73.747 98.675, 168.701 135.953, 189 144.518 C 192.025 145.794, 199.900 148.947, 206.500 151.525 C 223.306 158.088, 242.564 168.103, 248.626 173.432 C 260.872 184.198, 263.097 193.015, 257.096 207 C 255.326 211.125, 252.754 217.200, 251.381 220.500 C 250.008 223.800, 248.027 228.525, 246.980 231 C 245.933 233.475, 242.331 242.025, 238.977 250 C 235.623 257.975, 231.478 267.755, 229.766 271.733 C 226.251 279.902, 225.973 277.689, 232.936 297 C 235.217 303.325, 240.179 317.500, 243.964 328.500 C 252.501 353.313, 258.739 370.768, 259.522 372.036 C 259.901 372.649, 244.161 373, 216.264 373 L 172.411 373 150.955 390.968 C 139.155 400.850, 129.500 409.512, 129.500 410.218 C 129.500 411.249, 143.477 411.500, 200.858 411.500 L 272.216 411.500 282.197 403 C 287.686 398.325, 294.025 393.017, 296.284 391.205 C 298.542 389.392, 302.591 385.850, 305.282 383.333 L 310.174 378.757 307.661 371.128 C 306.279 366.933, 302.370 355.625, 298.974 346 C 295.579 336.375, 289.514 319.050, 285.498 307.500 C 281.481 295.950, 277.718 285.279, 277.136 283.786 C 276.272 281.573, 276.510 280.099, 278.425 275.786 C 279.716 272.879, 283.106 264.875, 285.958 258 C 288.810 251.125, 293.333 240.325, 296.009 234 C 298.684 227.675, 303.619 215.975, 306.975 208 C 310.330 200.025, 313.943 191.475, 315.002 189 C 324.190 167.542, 326.983 160.397, 326.586 159.362 C 325.203 155.760, 292.893 138.471, 274.500 131.491 C 262.871 127.078, 226.856 116.175, 204.689 110.356 C 196.469 108.199, 170.171 103.049, 156.500 100.920 C 153.200 100.406, 145.775 98.879, 140 97.527 C 128.326 94.793, 116.390 92.763, 95.500 89.957 C 78.174 87.630, 57.967 84.449, 51.967 83.105 C 45.278 81.606, 27.153 80.949, 22.072 82.022 M 122 261.500 C 122 328.325, 122.244 383, 122.542 383 C 122.840 383, 131.278 376.134, 141.292 367.743 C 151.306 359.351, 160.730 351.529, 162.234 350.361 L 164.968 348.237 165 261.369 C 165.018 213.591, 165.025 170.155, 165.016 164.844 L 165 155.188 160.750 153.664 C 158.412 152.826, 152.900 150.737, 148.500 149.023 C 133.559 143.201, 124.621 140, 123.309 140 C 122.238 140, 122 162.065, 122 261.500"/></symbol></defs>`;
  document.body.appendChild(bladeDefs);

  const panel = document.createElement('div');
  panel.id = 'ii-ai-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'AI Informant');
  panel.innerHTML = `
    <button class="ii-close-float" id="ii-close-btn" aria-label="Close AI Informant">×</button>
    <div class="ii-msgs" id="ii-msgs"></div>
    <div class="ii-input-row">
      <textarea id="ii-inp" rows="1" placeholder="Ask anything…"></textarea>
      <button id="ii-send">Send</button>
    </div>
  `;
  document.body.appendChild(panel);

  // Floating trigger button
  const floatBtn = document.createElement('button');
  floatBtn.id = 'ii-chat-btn';
  floatBtn.setAttribute('aria-label', 'AI Informant');
  floatBtn.innerHTML = `<svg class="ii-blade-icon" viewBox="0 0 432 466" aria-hidden="true"><use href="#ii-blade"></use></svg><span class="ii-sweep" aria-hidden="true"></span><span class="ii-tooltip" role="tooltip">AI Informant</span>`;
  floatBtn.addEventListener('click', () => window.iiToggleChat?.());
  document.body.appendChild(floatBtn);

  function buildStarters() {
    const el = document.createElement('div');
    el.className = 'ii-starters';
    starters.forEach(text => {
      const btn = document.createElement('button');
      btn.className = 'ii-sq';
      btn.textContent = text;
      btn.addEventListener('click', () => send(text));
      el.appendChild(btn);
    });
    return el;
  }

  // ── Logic ─────────────────────────────────────────────────────────────────
  const msgsEl  = document.getElementById('ii-msgs');
  const inp     = document.getElementById('ii-inp');
  const sendBtn = document.getElementById('ii-send');
  let open = false;
  let history = [];
  let busy = false;
  let introStarted = false;
  let startersEl = null;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // One avatar, relocated into whichever row is "current" and FLIP-animated
  // between positions — it glides down to each new message rather than
  // printing a new icon per row. Animating a `top` offset on a floating icon
  // (the earlier approach) could land it past the row it was aiming for —
  // moving the real element into the row makes that layout-impossible, and
  // the transform transition keeps the same smooth glide.
  const avatarWrap = document.createElement('div');
  avatarWrap.className = 'ii-row-avatar';
  const avatarEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  avatarEl.setAttribute('viewBox', '0 0 432 466');
  avatarEl.setAttribute('aria-hidden', 'true');
  avatarEl.classList.add('ii-avatar');
  avatarEl.innerHTML = '<use href="#ii-blade"></use>';
  avatarWrap.appendChild(avatarEl);

  function moveAvatarTo(rowEl, busy) {
    const prevRect = avatarWrap.isConnected ? avatarWrap.getBoundingClientRect() : null;
    rowEl.prepend(avatarWrap);
    avatarEl.classList.toggle('ii-avatar-busy', !!busy);
    if (!prevRect) return;
    const newRect = avatarWrap.getBoundingClientRect();
    const dx = prevRect.left - newRect.left;
    const dy = prevRect.top - newRect.top;
    if (!dx && !dy) return;
    avatarWrap.style.transition = 'none';
    avatarWrap.style.transform = `translate(${dx}px, ${dy}px)`;
    avatarWrap.getBoundingClientRect(); // force reflow so the jump above renders before animating
    avatarWrap.style.transition = 'transform 0.45s cubic-bezier(0.22, 1, 0.36, 1)';
    avatarWrap.style.transform = '';
  }

  function makeThinkingText() {
    const span = document.createElement('span');
    span.textContent = 'Thinking';
    const dots = document.createElement('span');
    dots.className = 'ii-thinking-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    span.appendChild(dots);
    return span;
  }

  async function typeText(el, text, speed = 14) {
    for (let i = 1; i <= text.length; i++) {
      el.textContent = text.slice(0, i);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      await sleep(speed);
    }
  }

  async function playIntro() {
    const lines = [
      "Have a stock, event, or topic in mind? Drop a ticker, a headline, or a theme and I'll break down the market implications in real time.",
      "You can also ask me how anything on this site works, what the data means, or anything else.",
    ];
    inp.disabled = true;
    sendBtn.disabled = true;
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'ii-row ii-m-thinking';
      const thinkingText = makeThinkingText();
      row.appendChild(thinkingText);
      msgsEl.appendChild(row);
      moveAvatarTo(row, true);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      await sleep(500);
      row.classList.remove('ii-m-thinking');
      thinkingText.remove();
      const bubble = document.createElement('div');
      bubble.className = 'ii-m ii-m-ai';
      row.appendChild(bubble);
      await typeText(bubble, line);
      moveAvatarTo(row, false);
      await sleep(250);
    }
    startersEl = buildStarters();
    msgsEl.appendChild(startersEl);
    inp.disabled = false;
    sendBtn.disabled = false;
  }

  function setOpen(v) {
    open = v;
    panel.classList.toggle('ii-open', open);
    const navBtn = document.getElementById('ii-chat-btn');
    if (navBtn) {
      navBtn.classList.toggle('active', open);
      navBtn.classList.toggle('ii-hidden', open);
    }
    if (open && !introStarted) {
      introStarted = true;
      playIntro();
    }
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
    if (role === 'user') {
      const d = document.createElement('div');
      d.className = 'ii-m ii-m-user';
      d.textContent = text;
      msgsEl.appendChild(d);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      return d;
    }
    const row = document.createElement('div');
    row.className = 'ii-row';
    const bubble = document.createElement('div');
    bubble.className = 'ii-m ii-m-ai';
    bubble.innerHTML = mdToHtml(text);
    row.appendChild(bubble);
    msgsEl.appendChild(row);
    moveAvatarTo(row, false);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return bubble;
  }

  function addThinking() {
    const row = document.createElement('div');
    row.className = 'ii-row ii-m-thinking';
    const thinkingText = makeThinkingText();
    row.appendChild(thinkingText);
    msgsEl.appendChild(row);
    moveAvatarTo(row, true);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return row;
  }

  async function send(text) {
    text = (text || inp.value).trim();
    if (!text || busy) return;

    startersEl?.remove();
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
      const data = await res.json();
      const reply = data.reply || data.error || 'Something went wrong. Try again.';
      addMsg('assistant', reply); // moves the avatar into the new row first — only then is it safe to remove the old one
      thinking.remove();
      history.push({ role: 'assistant', content: reply });
    } catch (e) {
      addMsg('assistant', e.name === 'TimeoutError'
        ? 'The request timed out. Please try again.'
        : 'Connection error. Please try again.');
      thinking.remove();
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
