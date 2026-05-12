(function () {
  if (document.getElementById('ii-ai-bar')) return;

  const PAGE_CONTEXTS = {
    'feed.html':        'stock-markets',
    'predictions.html': 'prediction-markets',
    'markets.html':     'prediction-markets',
    'crypto.html':      'crypto',
  };

  const PAGE_STARTERS = {
    'stock-markets':     ["What's moving markets today?", "How do confidence stars work?", "Explain the winners/losers logic"],
    'prediction-markets':["How do I read Polymarket odds?", "What does 65% YES mean?", "Which markets have the most volume?"],
    'crypto':            ["When is crypto launching?", "What will the crypto section cover?", "How do I track Bitcoin news?"],
  };

  const page = window.location.pathname.split('/').pop() || '';
  const pageContext = PAGE_CONTEXTS[page] || 'general';
  const starters = PAGE_STARTERS[pageContext] || ["How does this site work?", "What are prediction markets?", "How is confidence calculated?"];

  // ── Styles ────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    /* Always-visible right strip */
    #ii-ai-bar {
      position: fixed;
      top: 0;
      right: 0;
      width: 36px;
      height: 100vh;
      height: 100dvh;
      background: #e8e8e8;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      box-shadow: -2px 0 8px rgba(0,0,0,0.08);
      border-left: 1px solid #d8d8d8;
    }
    #ii-ai-label {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      font-family: 'DM Sans', sans-serif;
      font-weight: 500;
      font-size: 9px;
      letter-spacing: 1.4px;
      color: #555;
      text-transform: uppercase;
      user-select: none;
      pointer-events: none;
      text-align: center;
    }
    #ii-ai-toggle {
      background: none;
      border: none;
      color: #666;
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      padding: 6px 0;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      transition: color 0.15s;
      font-family: 'DM Sans', sans-serif;
      font-weight: 300;
    }
    #ii-ai-toggle:hover { color: #111; }

    /* Sliding panel to the left of the bar */
    #ii-ai-panel {
      position: fixed;
      top: 0;
      right: 36px;
      width: min(390px, 33vw);
      height: 100vh;
      height: 100dvh;
      background: #f0f0f0;
      z-index: 9998;
      display: flex;
      flex-direction: column;
      box-shadow: -4px 0 24px rgba(0,0,0,0.1);
      transform: translateX(calc(100% + 36px));
      transition: transform 0.32s cubic-bezier(0.4, 0, 0.2, 1);
    }
    #ii-ai-panel.ii-open {
      transform: translateX(0);
    }
    @media (max-width: 640px) {
      #ii-ai-panel {
        width: calc(100vw - 36px);
      }
    }

    /* Panel header */
    .ii-ph {
      background: #ffffff;
      padding: 15px 16px;
      display: flex;
      align-items: center;
      flex-shrink: 0;
      border-bottom: 1px solid #ebebeb;
    }
    .ii-ph-title {
      font-family: 'DM Sans', sans-serif;
      font-weight: 600;
      font-size: 13px;
      color: #111;
      letter-spacing: -0.2px;
    }
    .ii-ph-title em {
      background: #00e676;
      color: #111111;
      font-style: normal;
      padding: 1px 5px;
      margin-right: 5px;
    }

    /* Messages */
    .ii-msgs {
      flex: 1;
      overflow-y: auto;
      padding: 14px 14px 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      scroll-behavior: smooth;
      -webkit-overflow-scrolling: touch;
    }
    .ii-msgs::-webkit-scrollbar { width: 4px; }
    .ii-msgs::-webkit-scrollbar-track { background: transparent; }
    .ii-msgs::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }
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
      background: #00e676;
      color: #111111;
      padding: 8px 12px;
      border-radius: 12px 12px 3px 12px;
      font-weight: 500;
    }
    .ii-m-ai {
      align-self: flex-start;
      background: #ffffff;
      color: #222;
      padding: 9px 13px;
      border-radius: 12px 12px 12px 3px;
      border: 1px solid #e5e5e5;
    }
    .ii-m-thinking {
      align-self: flex-start;
      display: flex;
      align-items: center;
      gap: 7px;
      color: #aaa;
      font-size: 12px;
      font-style: italic;
      font-family: 'DM Sans', sans-serif;
      padding: 3px 0;
    }
    .ii-dots span {
      display: inline-block;
      width: 4px; height: 4px;
      background: #bbb;
      border-radius: 50%;
      animation: ii-bop 1.1s ease-in-out infinite;
    }
    .ii-dots span:nth-child(2) { animation-delay: 0.18s; }
    .ii-dots span:nth-child(3) { animation-delay: 0.36s; }
    @keyframes ii-bop {
      0%,80%,100% { transform: translateY(0); opacity:.35; }
      40% { transform: translateY(-4px); opacity:1; }
    }

    /* Starters */
    .ii-starters {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 2px;
    }
    .ii-sq {
      background: #ffffff;
      border: 1px solid #e5e5e5;
      border-radius: 8px;
      padding: 8px 11px;
      font-family: 'DM Sans', sans-serif;
      font-size: 12px;
      color: #555;
      cursor: pointer;
      text-align: left;
      line-height: 1.4;
      transition: background .15s, border-color .15s, color .15s;
    }
    .ii-sq:hover { background: #f0fff8; border-color: #00e676; color: #111; }

    /* Input row */
    .ii-input-row {
      display: flex;
      gap: 8px;
      padding: 10px 12px;
      padding-bottom: max(10px, env(safe-area-inset-bottom));
      border-top: 1px solid #ebebeb;
      background: #ffffff;
      flex-shrink: 0;
    }
    #ii-inp {
      flex: 1;
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      padding: 8px 11px;
      background: #f5f5f5;
      color: #222;
      resize: none;
      outline: none;
      line-height: 1.45;
      max-height: 90px;
      overflow-y: auto;
    }
    #ii-inp::placeholder { color: #aaa; }
    #ii-inp:focus { border-color: #bbb; background: #fff; }
    #ii-send {
      background: #00e676;
      color: #111111;
      border: none;
      border-radius: 6px;
      padding: 0 13px;
      font-family: 'DM Sans', sans-serif;
      font-weight: 600;
      font-size: 12px;
      letter-spacing: .2px;
      cursor: pointer;
      flex-shrink: 0;
      transition: opacity .15s;
    }
    #ii-send:hover { opacity: .8; }
    #ii-send:disabled { opacity: .3; cursor: not-allowed; }
  `;
  document.head.appendChild(style);

  // ── DOM ───────────────────────────────────────────────────────────────────
  const bar = document.createElement('div');
  bar.id = 'ii-ai-bar';
  bar.innerHTML = `
    <div id="ii-ai-label">Live Chat</div>
    <button id="ii-ai-toggle" aria-label="Open AI Informant">&#8249;</button>
  `;
  document.body.appendChild(bar);

  const panel = document.createElement('div');
  panel.id = 'ii-ai-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'AI Informant');
  panel.innerHTML = `
    <div class="ii-ph">
      <div class="ii-ph-title"><em>II</em> AI Informant</div>
    </div>
    <div class="ii-msgs" id="ii-msgs">
      <div class="ii-m ii-m-ai"><strong>Have a stock, event, or topic in mind?</strong> That's what I'm here for — drop a ticker, a headline, or a theme and I'll break down the market implications in real time.<br><br>You can also ask me how anything on this site works, what the data means, or anything else.</div>
      <div class="ii-starters" id="ii-starters"></div>
    </div>
    <div class="ii-input-row">
      <textarea id="ii-inp" rows="1" placeholder="Ask about a stock, sector, or the site…"></textarea>
      <button id="ii-send">Send</button>
    </div>
  `;
  document.body.appendChild(panel);

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
  const toggle  = document.getElementById('ii-ai-toggle');
  const msgsEl  = document.getElementById('ii-msgs');
  const inp     = document.getElementById('ii-inp');
  const sendBtn = document.getElementById('ii-send');
  let open = false;
  let history = [];
  let busy = false;

  function setOpen(v) {
    open = v;
    panel.classList.toggle('ii-open', open);
    // ‹ when closed (click to expand left), › when open (click to collapse right)
    toggle.innerHTML = open ? '&#8250;' : '&#8249;';
    toggle.setAttribute('aria-label', open ? 'Close AI Informant' : 'Open AI Informant');
  }

  toggle.addEventListener('click', () => setOpen(!open));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) setOpen(false); });

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
        out.push(`<p style="font-weight:700;font-size:13px;margin:10px 0 2px">${inline(t.slice(4))}</p>`);
      } else if (/^## /.test(t)) {
        closeList();
        out.push(`<p style="font-weight:700;font-size:13.5px;margin:12px 0 2px">${inline(t.slice(3))}</p>`);
      } else if (/^# /.test(t)) {
        closeList();
        out.push(`<p style="font-weight:700;font-size:14px;margin:14px 0 4px">${inline(t.slice(2))}</p>`);
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
    busy = true;
    startersEl.remove();
    inp.value = '';
    inp.style.height = 'auto';
    sendBtn.disabled = true;

    addMsg('user', text);
    history.push({ role: 'user', content: text });

    const thinking = addThinking();
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, pageContext }),
        signal: AbortSignal.timeout(35000)
      });
      thinking.remove();
      const data = await res.json();
      const reply = data.reply || data.error || 'Something went wrong — try again.';
      addMsg('assistant', reply);
      history.push({ role: 'assistant', content: reply });
    } catch (e) {
      thinking.remove();
      addMsg('assistant', e.name === 'TimeoutError'
        ? 'The request timed out — please try again.'
        : 'Connection error — please try again.');
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
    inp.style.height = Math.min(inp.scrollHeight, 90) + 'px';
  });
})();
