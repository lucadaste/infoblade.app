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
      color: var(--ink);
      border-radius: 50%;
      border: none;
      cursor: pointer;
      overflow: visible;
      isolation: isolate;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.2s, transform 0.2s;
      box-shadow: 0 4px 24px rgba(0,0,0,0.6);
    }
    #ii-chat-btn:hover { transform: translateY(-50%) scale(1.06); }
    #ii-chat-btn .ii-spark {
      width: 20px; height: 20px;
      flex-shrink: 0;
      filter: drop-shadow(0 0 5px rgba(0,230,118,0.85));
      animation: ii-spark-pulse 2.4s ease-in-out infinite;
    }
    @keyframes ii-spark-pulse {
      0%, 100% { transform: scale(1) rotate(0deg); opacity: 1; }
      50% { transform: scale(1.18) rotate(10deg); opacity: 0.8; }
    }
    #ii-chat-btn::before {
      content: '';
      position: absolute;
      width: 300px; height: 300px;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%) rotate(0deg);
      background: conic-gradient(from 0deg, transparent 0deg, #00e676 55deg, #b8ffe0 85deg, #ffffff 105deg, #b8ffe0 125deg, #00e676 175deg, transparent 235deg);
      animation: ii-spin 2.8s linear infinite;
      border-radius: 50%;
      z-index: -1;
    }
    #ii-chat-btn::after {
      content: '';
      position: absolute;
      inset: 2px;
      background: var(--card);
      border-radius: 50%;
      z-index: -1;
      transition: background 0.2s;
    }
    #ii-chat-btn:hover::after { background: var(--surface-2); }
    #ii-chat-btn.active { color: var(--accent); }
    #ii-chat-btn.active::after { background: var(--surface-2); }
    @keyframes ii-spin { to { transform: translate(-50%, -50%) rotate(360deg); } }

    #ii-chat-btn .ii-pulse-ring {
      position: absolute;
      inset: -6px;
      border-radius: 50%;
      border: 1.5px solid var(--accent);
      opacity: 0;
      animation: ii-ring-pulse 2.8s ease-out infinite;
      pointer-events: none;
    }
    #ii-chat-btn.active .ii-pulse-ring { animation: none; opacity: 0; }
    @keyframes ii-ring-pulse {
      0% { transform: scale(0.85); opacity: 0.55; }
      70% { transform: scale(1.35); opacity: 0; }
      100% { transform: scale(1.35); opacity: 0; }
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
  floatBtn.innerHTML = `<svg class="ii-spark" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12 0C12 6.627 6.627 12 0 12C6.627 12 12 17.373 12 24C12 17.373 17.373 12 24 12C17.373 12 12 6.627 12 0Z" fill="var(--accent)"/></svg><span class="ii-pulse-ring" aria-hidden="true"></span><span class="ii-tooltip" role="tooltip">AI Informant</span>`;
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

  // Close when clicking outside the panel and trigger button
  document.addEventListener('click', e => {
    if (!open) return;
    const navBtn = document.getElementById('ii-chat-btn');
    if (!panel.contains(e.target) && (!navBtn || !navBtn.contains(e.target))) {
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
