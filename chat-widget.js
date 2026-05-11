(function () {
  if (document.getElementById('ii-chat-bar')) return;

  const PAGE_CONTEXTS = {
    'feed.html':        'stock-markets',
    'predictions.html': 'prediction-markets',
    'markets.html':     'prediction-markets',
    'crypto.html':      'crypto',
    'index.html':       'home',
    '':                 'home',
  };

  const PAGE_STARTERS = {
    'stock-markets':     ['What's moving markets today?', 'How do confidence stars work?', 'Explain the winners/losers logic'],
    'prediction-markets':['How do I read Polymarket odds?', 'What does 65% YES mean?', 'Which markets have the most volume?'],
    'crypto':            ['When is crypto launching?', 'What will the crypto section cover?', 'How do I track Bitcoin news?'],
    'home':              ['How does this site work?', 'What's the difference between the tools?', 'How accurate are the predictions?'],
    'general':           ['How does this site work?', 'What are prediction markets?', 'How is confidence calculated?'],
  };

  const page = window.location.pathname.split('/').pop() || 'index.html';
  const pageContext = PAGE_CONTEXTS[page] || 'general';
  const starters = PAGE_STARTERS[pageContext] || PAGE_STARTERS.general;

  // ── Styles ──────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #ii-chat-bar {
      position: fixed;
      top: 0;
      right: 0;
      width: 44px;
      height: 100vh;
      height: 100dvh;
      background: #0a0a0a;
      z-index: 9998;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      cursor: pointer;
      transition: width 0.35s cubic-bezier(0.4, 0, 0.2, 1);
      overflow: hidden;
      box-shadow: -2px 0 16px rgba(0,0,0,0.12);
    }
    #ii-chat-bar.ii-expanded { width: min(400px, 33vw); cursor: default; }
    @media (max-width: 640px) {
      #ii-chat-bar.ii-expanded { width: 100vw; }
    }

    #ii-chat-tab {
      width: 44px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      height: 100%;
      transition: opacity 0.15s;
      user-select: none;
    }
    #ii-chat-bar.ii-expanded #ii-chat-tab { opacity: 0; pointer-events: none; }

    .ii-tab-dot {
      width: 28px; height: 28px;
      background: #c8ff00;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; line-height: 1;
    }
    .ii-tab-label {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      font-family: 'Syne', 'Arial Black', sans-serif;
      font-weight: 800;
      font-size: 10px;
      letter-spacing: 2.5px;
      color: #c8ff00;
      text-transform: uppercase;
    }

    #ii-chat-panel {
      position: absolute;
      top: 0; left: 44px; right: 0; bottom: 0;
      display: flex;
      flex-direction: column;
      background: #f5f2eb;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s 0.12s;
      min-width: 0;
    }
    #ii-chat-bar.ii-expanded #ii-chat-panel { opacity: 1; pointer-events: all; }

    .ii-chat-header {
      background: #0a0a0a;
      padding: 14px 14px 14px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
      gap: 10px;
    }
    .ii-chat-title {
      font-family: 'Syne', 'Arial Black', sans-serif;
      font-weight: 800;
      font-size: 13px;
      color: white;
      letter-spacing: -0.3px;
      white-space: nowrap;
    }
    .ii-chat-title span { background: #c8ff00; color: #0a0a0a; padding: 1px 5px; margin-right: 4px; }
    .ii-chat-close-btn {
      background: none; border: none;
      color: #6b6b6b; font-size: 18px; line-height: 1;
      cursor: pointer; padding: 2px 4px;
      transition: color 0.15s; flex-shrink: 0;
    }
    .ii-chat-close-btn:hover { color: white; }

    .ii-chat-msgs {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      scroll-behavior: smooth;
      -webkit-overflow-scrolling: touch;
    }
    .ii-msg {
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .ii-msg-user {
      align-self: flex-end;
      max-width: 88%;
      background: #0a0a0a;
      color: white;
      padding: 8px 12px;
      border-radius: 12px 12px 3px 12px;
    }
    .ii-msg-ai {
      align-self: flex-start;
      max-width: 92%;
      background: white;
      color: #0a0a0a;
      padding: 10px 13px;
      border-radius: 12px 12px 12px 3px;
      border: 1px solid #e0ddd6;
    }
    .ii-msg-thinking {
      align-self: flex-start;
      color: #9b9b9b;
      font-size: 12px;
      font-style: italic;
      font-family: 'DM Sans', sans-serif;
      padding: 4px 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .ii-think-dots span {
      display: inline-block;
      width: 4px; height: 4px;
      background: #9b9b9b;
      border-radius: 50%;
      animation: ii-bounce 1.2s ease-in-out infinite;
    }
    .ii-think-dots span:nth-child(2) { animation-delay: 0.2s; }
    .ii-think-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes ii-bounce {
      0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
      40% { transform: translateY(-4px); opacity: 1; }
    }

    .ii-starters {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 2px;
    }
    .ii-starter-btn {
      background: white;
      border: 1px solid #e0ddd6;
      border-radius: 8px;
      padding: 8px 12px;
      font-family: 'DM Sans', sans-serif;
      font-size: 12px;
      color: #0a0a0a;
      cursor: pointer;
      text-align: left;
      transition: background 0.15s, border-color 0.15s;
      line-height: 1.4;
    }
    .ii-starter-btn:hover { background: #eceae3; border-color: #c8b890; }

    .ii-chat-input-row {
      display: flex;
      gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid #e0ddd6;
      background: white;
      flex-shrink: 0;
      padding-bottom: max(10px, env(safe-area-inset-bottom));
    }
    #ii-chat-input {
      flex: 1;
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      border: 1px solid #e0ddd6;
      border-radius: 6px;
      padding: 8px 11px;
      background: #f5f2eb;
      color: #0a0a0a;
      resize: none;
      outline: none;
      line-height: 1.45;
      max-height: 96px;
      overflow-y: auto;
    }
    #ii-chat-input::placeholder { color: #9b9b9b; }
    #ii-chat-input:focus { border-color: #0a0a0a; }
    #ii-chat-send {
      background: #0a0a0a;
      color: white;
      border: none;
      border-radius: 6px;
      padding: 0 14px;
      font-family: 'Syne', 'Arial Black', sans-serif;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
      transition: opacity 0.15s;
      flex-shrink: 0;
      letter-spacing: 0.3px;
    }
    #ii-chat-send:hover { opacity: 0.8; }
    #ii-chat-send:disabled { opacity: 0.35; cursor: not-allowed; }
  `;
  document.head.appendChild(style);

  // ── HTML ────────────────────────────────────────────────────────────────────
  const bar = document.createElement('div');
  bar.id = 'ii-chat-bar';
  bar.setAttribute('aria-label', 'AI Assistant');
  bar.innerHTML = `
    <div id="ii-chat-tab" role="button" aria-label="Open AI Assistant">
      <div class="ii-tab-dot">✦</div>
      <div class="ii-tab-label">Ask AI</div>
    </div>
    <div id="ii-chat-panel" role="dialog" aria-label="AI Assistant">
      <div class="ii-chat-header">
        <div class="ii-chat-title"><span>II</span> AI Assistant</div>
        <button class="ii-chat-close-btn" id="ii-close-btn" aria-label="Close">✕</button>
      </div>
      <div class="ii-chat-msgs" id="ii-msgs">
        <div class="ii-msg ii-msg-ai">Hi! I'm the InvestmentInformatics AI. Ask me about any stock, sector, or market theme — or how to use the site.</div>
        <div class="ii-starters" id="ii-starters"></div>
      </div>
      <div class="ii-chat-input-row">
        <textarea id="ii-chat-input" rows="1" placeholder="Ask about a stock, sector, or the site…"></textarea>
        <button id="ii-chat-send">Send</button>
      </div>
    </div>
  `;
  document.body.appendChild(bar);

  // Populate starters
  const startersEl = document.getElementById('ii-starters');
  starters.forEach(text => {
    const btn = document.createElement('button');
    btn.className = 'ii-starter-btn';
    btn.textContent = text;
    btn.addEventListener('click', () => send(text));
    startersEl.appendChild(btn);
  });

  // ── State & helpers ──────────────────────────────────────────────────────────
  const msgsEl   = document.getElementById('ii-msgs');
  const inputEl  = document.getElementById('ii-chat-input');
  const sendBtn  = document.getElementById('ii-chat-send');
  const closeBtn = document.getElementById('ii-close-btn');
  const tab      = document.getElementById('ii-chat-tab');
  let history    = [];
  let busy       = false;

  function openPanel() { bar.classList.add('ii-expanded'); }
  function closePanel() { bar.classList.remove('ii-expanded'); }

  tab.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closePanel(); });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && bar.classList.contains('ii-expanded')) closePanel();
  });

  function addMsg(role, text) {
    const d = document.createElement('div');
    d.className = 'ii-msg ' + (role === 'user' ? 'ii-msg-user' : 'ii-msg-ai');
    d.textContent = text;
    msgsEl.appendChild(d);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return d;
  }

  function addThinking() {
    const d = document.createElement('div');
    d.className = 'ii-msg-thinking';
    d.innerHTML = `<span class="ii-think-dots"><span></span><span></span><span></span></span> Thinking…`;
    msgsEl.appendChild(d);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return d;
  }

  async function send(text) {
    text = (text || inputEl.value).trim();
    if (!text || busy) return;
    busy = true;

    // Remove starters on first message
    startersEl.remove();

    inputEl.value = '';
    inputEl.style.height = 'auto';
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
    inputEl.focus();
  }

  sendBtn.addEventListener('click', () => send());
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 96) + 'px';
  });
})();
