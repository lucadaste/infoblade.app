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
      font-family: 'Space Grotesk', sans-serif;
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
      font-size: 14.5px;
    }
    .ii-row .ii-m-ai { max-width: none; min-width: 0; }
    .ii-avatar {
      width: 2.3em;
      height: 2.3em;
      fill: var(--accent);
      transform-origin: center;
      display: block;
    }
    .ii-row-avatar {
      /* Avatar (2.3em) is taller than one line of message text (line-height
         1.6 * 14.5px font-size), so centering it on the row's own height
         would need align-items: center — but that drags it to the middle
         of multi-paragraph replies instead of pinning to the first line.
         Staying flex-start and centering the avatar against just the
         first line via margin-top keeps both: (lineHeight - avatarHeight) / 2. */
      flex-shrink: 0;
      margin-top: -0.35em;
      pointer-events: none;
    }
    .ii-avatar-busy {
      -webkit-mask-image: linear-gradient(115deg, #000 35%, rgba(0,0,0,0.3) 50%, #000 65%);
      mask-image: linear-gradient(115deg, #000 35%, rgba(0,0,0,0.3) 50%, #000 65%);
      -webkit-mask-size: 250% 100%;
      mask-size: 250% 100%;
      animation: ii-avatar-shimmer 1.6s linear infinite;
    }
    @keyframes ii-avatar-shimmer {
      0% { -webkit-mask-position: 160% 0; mask-position: 160% 0; }
      100% { -webkit-mask-position: -60% 0; mask-position: -60% 0; }
    }
    .ii-thinking-shimmer {
      background-image: linear-gradient(90deg, var(--muted) 0%, var(--muted) 38%, var(--ink) 50%, var(--muted) 62%, var(--muted) 100%);
      background-size: 200% 100%;
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      color: transparent;
      animation: ii-shimmer-sweep 1.6s linear infinite;
    }
    @keyframes ii-shimmer-sweep {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .ii-cursor {
      display: inline-block;
      width: 2px;
      height: 1em;
      margin-left: 1px;
      vertical-align: text-bottom;
      background: var(--accent);
      animation: ii-cursor-blink 0.8s step-end infinite;
    }
    @keyframes ii-cursor-blink {
      0%, 50% { opacity: 1; }
      50.01%, 100% { opacity: 0; }
    }
    .ii-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 18px 12px;
      flex-shrink: 0;
      border-radius: 10px 10px 0 0;
    }
    .ii-header-title {
      font-family: 'Space Grotesk', sans-serif;
      font-weight: 600;
      font-size: 12px;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--muted);
    }
    .ii-header-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .ii-icon-btn {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: var(--surface-2);
      border: 1px solid var(--border);
      padding: 0;
      font-size: 15px;
      line-height: 1;
      color: var(--muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: color 0.15s, background 0.15s;
    }
    .ii-icon-btn:hover { color: var(--ink); background: var(--card); }
    .ii-icon-btn svg { width: 14px; height: 14px; }

    .ii-history-panel {
      flex: 1;
      overflow-y: auto;
      padding: 4px 22px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 0;
    }
    .ii-history-new {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      font-family: 'Space Grotesk', sans-serif;
      font-size: 13px;
      font-weight: 600;
      color: var(--ink);
      cursor: pointer;
      text-align: left;
      flex-shrink: 0;
      transition: border-color 0.15s, color 0.15s;
    }
    .ii-history-new:hover { border-color: var(--accent); color: var(--accent); }
    .ii-history-list { display: flex; flex-direction: column; gap: 6px; }
    .ii-history-item {
      background: none;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      cursor: pointer;
      text-align: left;
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-family: 'Space Grotesk', sans-serif;
      transition: background 0.15s, border-color 0.15s;
    }
    .ii-history-item:hover { background: var(--hover-tint); border-color: var(--divider); }
    .ii-history-item-preview {
      font-size: 13px;
      color: var(--ink);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ii-history-item-date { font-size: 11px; color: var(--muted); }
    .ii-history-empty { color: var(--muted); font-size: 13px; padding: 16px 0; text-align: center; }

    .ii-msgs {
      position: relative;
      flex: 1;
      overflow-y: auto;
      padding: 8px 22px 14px;
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
    .ii-msgs[hidden], .ii-history-panel[hidden] { display: none; }

    .ii-m {
      font-family: 'Space Grotesk', sans-serif;
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
      /* Matches .ii-m's 1.6 line-height ratio — without this it fell back
         to the browser's default "normal" line-height, which made this
         row's line box shorter than the one the avatar's margin-top is
         centered against, throwing off the icon/text alignment here only. */
      line-height: 1.6;
      font-family: 'Space Grotesk', sans-serif;
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
      font-family: 'Space Grotesk', sans-serif;
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
      font-family: 'Space Grotesk', sans-serif;
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
      font-family: 'Space Grotesk', sans-serif;
      font-weight: 700;
      font-size: 13px;
      letter-spacing: .3px;
      cursor: pointer;
      flex-shrink: 0;
      transition: opacity .15s;
    }
    #ii-send:hover { opacity: .8; }
    #ii-send:disabled { opacity: .3; cursor: not-allowed; }

    .ii-attach-btn { align-self: flex-end; margin-bottom: 1px; }
    .ii-attach-btn svg { width: 14px; height: 14px; }

    .ii-attach-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 10px 18px 0;
      flex-shrink: 0;
    }
    .ii-attach-chip {
      position: relative;
      width: 52px;
      height: 52px;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--border);
      flex-shrink: 0;
    }
    .ii-attach-chip img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .ii-attach-remove {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: rgba(0,0,0,0.65);
      color: #fff;
      border: none;
      font-size: 11px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ii-attach-remove:hover { background: rgba(0,0,0,0.85); }

    .ii-msg-images { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; justify-content: flex-end; }
    .ii-msg-images img { width: 72px; height: 72px; object-fit: cover; border-radius: 8px; display: block; }
    .ii-mkts { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
    .ii-mkt { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); }
    .ii-mkt-body { flex: 1; min-width: 0; }
    .ii-mkt-title { font-size: 12.5px; font-weight: 600; color: var(--ink); line-height: 1.3; }
    .ii-mkt-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .ii-mkt-odds { flex-shrink: 0; text-align: right; font-family: 'Share Tech Mono', monospace; font-size: 16px; font-weight: 700; color: var(--ink); }
    .ii-mkt-odds span { display: block; font-family: 'DM Sans', sans-serif; font-size: 10px; font-weight: 500; color: var(--muted); max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ii-mkts-all { font-size: 12px; font-weight: 600; color: var(--accent); text-decoration: none; margin-top: 2px; }
    .ii-mkts-all:hover { text-decoration: underline; }

    .ii-drop-overlay {
      position: absolute;
      inset: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.55);
      border: 2px dashed var(--accent);
      border-radius: 10px;
      pointer-events: none;
    }
    .ii-drop-overlay span {
      font-family: 'Space Grotesk', sans-serif;
      font-weight: 600;
      font-size: 14px;
      color: var(--ink);
      background: var(--card);
      padding: 10px 18px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .ii-attach-row[hidden], .ii-drop-overlay[hidden] { display: none; }

    @media (max-width: 480px) {
      #ii-chat-btn { width: 50px; height: 50px; bottom: 148px; }
      #ii-ai-panel { bottom: 208px; max-height: min(480px, calc(100vh - 232px)); }
      .ii-tooltip { display: none; }
    }

    @media (min-width: 1024px) {
      #ii-chat-btn { bottom: 154px; }
      #ii-ai-panel { bottom: 220px; width: min(500px, calc(100vw - 32px)); max-height: min(660px, calc(100vh - 244px)); }
    }

    /* Home page only, once there's enough width to hold both the page
       content and the chat without cramping either: the panel lives
       docked to the right permanently as part of the page itself — no
       card chrome, no trigger icon, no close control. Other pages never
       get .ii-embedded, so they keep the normal icon popup at any width.
       --ii-chat-w scales the dock width down smoothly as the window
       narrows (520px down to a 340px floor) instead of jumping at a fixed
       breakpoint; home.html reads the same variable to shrink its own
       content column by exactly that much, so the two never overlap.
       1180px (not 1024) because below that the dashboard's own heading
       ("Welcome back, <username>") has no room left to shrink into and
       starts running under the dock. */
    @media (min-width: 1180px) {
      html.ii-chat-embedded {
        --ii-chat-w: clamp(340px, 34vw, 520px);
      }
      #ii-ai-panel.ii-embedded {
        top: 92px;
        bottom: 72px;
        right: 16px;
        width: var(--ii-chat-w);
        max-height: none;
        background: transparent;
        border: none;
        border-left: 1px solid var(--border);
        border-radius: 0;
        box-shadow: none;
        padding-left: 24px;
        transform: translateX(14px) scale(0.99);
        transform-origin: right center;
      }
      #ii-ai-panel.ii-embedded.ii-open { transform: translateX(0) scale(1); }
      #ii-ai-panel.ii-embedded .ii-close-btn { display: none; }
      #ii-ai-panel.ii-embedded .ii-header { padding-left: 0; padding-right: 0; }
      #ii-ai-panel.ii-embedded .ii-msgs { padding-left: 0; padding-right: 0; }
      #ii-ai-panel.ii-embedded .ii-input-row { background: transparent; padding-left: 0; padding-right: 0; }
      #ii-chat-btn.ii-embed-hidden { display: none; }
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
    <div class="ii-header">
      <span class="ii-header-title">AI Informant</span>
      <div class="ii-header-actions">
        <button class="ii-icon-btn" id="ii-history-btn" aria-label="Chat history" title="Chat history">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 1.8"/></svg>
        </button>
        <button class="ii-icon-btn ii-close-btn" id="ii-close-btn" aria-label="Close AI Informant">×</button>
      </div>
    </div>
    <div class="ii-history-panel" id="ii-history-panel" hidden>
      <button class="ii-history-new" id="ii-history-new">+ New chat</button>
      <div class="ii-history-list" id="ii-history-list"></div>
    </div>
    <div class="ii-msgs" id="ii-msgs"></div>
    <div class="ii-attach-row" id="ii-attach-row" hidden></div>
    <div class="ii-input-row">
      <button class="ii-icon-btn ii-attach-btn" id="ii-attach-btn" aria-label="Attach image" title="Attach image">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05 12.25 20.24a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.48"/></svg>
      </button>
      <input type="file" id="ii-file-input" accept="image/png,image/jpeg,image/webp,image/gif" multiple style="display:none">
      <textarea id="ii-inp" rows="1" placeholder="Ask anything…"></textarea>
      <button id="ii-send">Send</button>
    </div>
    <div class="ii-drop-overlay" id="ii-drop-overlay" hidden>
      <span>Drop image to attach</span>
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
  const msgsEl       = document.getElementById('ii-msgs');
  const inp          = document.getElementById('ii-inp');
  const sendBtn      = document.getElementById('ii-send');
  const historyBtn   = document.getElementById('ii-history-btn');
  const historyPanel = document.getElementById('ii-history-panel');
  const historyList  = document.getElementById('ii-history-list');
  const historyNewBtn = document.getElementById('ii-history-new');
  const attachBtn    = document.getElementById('ii-attach-btn');
  const fileInput    = document.getElementById('ii-file-input');
  const attachRow    = document.getElementById('ii-attach-row');
  const dropOverlay  = document.getElementById('ii-drop-overlay');
  let open = false;
  let history = [];
  let busy = false;
  let introStarted = false;
  let startersEl = null;
  let sessionId = null;     // set on first send of a conversation; carries that
                             // conversation's turns in chat_messages (see api/chat.js)
  let historyOpen = false;
  let attachedImages = []; // { mediaType, data (base64, no data: prefix), previewUrl }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Image attachments (drag-and-drop or the paperclip button) ───────────────
  const MAX_IMAGES = 2;
  const MAX_IMAGE_DIM = 1600; // longest side, px — downscaled client-side so a
                               // full-res phone photo never has to round-trip
                               // at full size before being resized server-side.
  const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

  function resizeImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          let { width, height } = img;
          if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
            const scale = MAX_IMAGE_DIM / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
          resolve({ mediaType: 'image/jpeg', data: dataUrl.split(',')[1], previewUrl: dataUrl });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderAttachRow() {
    attachRow.innerHTML = '';
    attachRow.hidden = attachedImages.length === 0;
    attachedImages.forEach((img, i) => {
      const chip = document.createElement('div');
      chip.className = 'ii-attach-chip';
      const thumb = document.createElement('img');
      thumb.src = img.previewUrl;
      thumb.alt = '';
      const rm = document.createElement('button');
      rm.className = 'ii-attach-remove';
      rm.setAttribute('aria-label', 'Remove image');
      rm.textContent = '×';
      rm.addEventListener('click', () => { attachedImages.splice(i, 1); renderAttachRow(); });
      chip.appendChild(thumb);
      chip.appendChild(rm);
      attachRow.appendChild(chip);
    });
  }

  async function addImageFiles(fileList) {
    const files = Array.from(fileList).filter(f => ACCEPTED_IMAGE_TYPES.includes(f.type));
    for (const file of files) {
      if (attachedImages.length >= MAX_IMAGES) break;
      try { attachedImages.push(await resizeImageFile(file)); } catch (e) { /* skip files the browser can't decode */ }
    }
    renderAttachRow();
  }

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addImageFiles(fileInput.files); fileInput.value = ''; });

  // Drag-and-drop anywhere on the panel. dragDepth tracks nested
  // enter/leave pairs (every child element fires its own), so the overlay
  // doesn't flicker as the pointer crosses from the panel onto a message
  // bubble and back while still dragging.
  let dragDepth = 0;
  panel.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  panel.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.hidden = false;
  });
  panel.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.hidden = true;
  });
  panel.addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    addImageFiles(e.dataTransfer.files);
  });

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
    span.className = 'ii-thinking-shimmer';
    span.textContent = 'Thinking…';
    return span;
  }

  async function typeText(el, text, speed = 14) {
    for (let i = 1; i <= text.length; i++) {
      el.textContent = text.slice(0, i);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      await sleep(speed);
    }
  }

  // Short one-liners shown instead of the full two-line walkthrough once a
  // signed-in user has seen that walkthrough INTRO_FULL_SHOWS times (see
  // fetchIntroShownCount / api/chat-intro.js). Keeps repeat visits snappy
  // instead of replaying the same onboarding copy forever.
  const QUIRKY_INTROS = [
    "Back again. What's moving?",
    "Markets never sleep. Neither do I. What are we looking at?",
    "Ticker, headline, or just a hunch — I'll take any of the three.",
    "What's on your radar today?",
    "Give me a ticker and I'll give you a take.",
    "Let's find the signal in the noise.",
    "Drop something: a ticker, a rumor, a theme.",
    "What are we digging into this time?",
    "I've got data, you've got questions. Go.",
    "Something caught your eye? Let's break it down.",
  ];

  const INTRO_FULL_SHOWS = 3;

  // Signed-in users get a persistent, account-wide count from api/chat-intro.js
  // so the full intro fades out after a few visits regardless of device.
  // Signed-out (or offline/error) always falls back to the full intro.
  async function fetchIntroShownCount() {
    const token = await window._auth?.getToken();
    if (!token) return 0;
    try {
      const res = await fetch(window.API_BASE + '/api/chat-intro', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) return 0;
      const data = await res.json();
      return data.count || 0;
    } catch (e) {
      return 0;
    }
  }

  async function playIntro() {
    const shownCount = await fetchIntroShownCount();
    const lines = shownCount < INTRO_FULL_SHOWS
      ? [
          "Have a stock, event, or topic in mind? Drop a ticker, a headline, or a theme and I'll break down the market implications in real time.",
          "You can also ask me how anything on this site works, what the data means, or anything else.",
        ]
      : [QUIRKY_INTROS[Math.floor(Math.random() * QUIRKY_INTROS.length)]];
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

  // Home page only, once there's enough width to hold both the page content
  // and the chat without cramping either (see the dock styles above): the
  // panel isn't a popup the user opens and dismisses there — it's a
  // permanent part of the page, no trigger icon or close control. Every
  // other page keeps the normal icon-triggered popup regardless of width.
  // Live as the viewport is resized across the breakpoint.
  const embedMq = window.matchMedia('(min-width: 1180px)');
  function isEmbedMode() { return page === 'home.html' && embedMq.matches; }

  function applyResponsiveMode() {
    const embedded = isEmbedMode();
    const wasEmbedded = panel.classList.contains('ii-embedded');
    panel.classList.toggle('ii-embedded', embedded);
    floatBtn.classList.toggle('ii-embed-hidden', embedded);
    document.documentElement.classList.toggle('ii-chat-embedded', embedded);
    if (embedded && !open) {
      setOpen(true);
    } else if (!embedded && wasEmbedded && open && history.length === 0) {
      // Dropping out of the embedded layout (window narrowed past the point
      // it fits) — go back to the closed icon rather than leaving a popup
      // sitting open that nobody asked to open. Skip this if there's an
      // actual conversation going, so narrowing the window mid-chat doesn't
      // yank it away.
      setOpen(false);
    }
  }

  document.getElementById('ii-close-btn').addEventListener('click', () => { if (!isEmbedMode()) setOpen(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open && !isEmbedMode()) setOpen(false); });

  // Close when clicking outside the panel and trigger button.
  // Uses composedPath (the click's ancestor chain captured at dispatch time)
  // instead of panel.contains(e.target) — some in-panel clicks (e.g. a
  // starter-question chip) synchronously remove their own container as part
  // of handling the click, which detaches e.target from the document before
  // this listener runs. A detached node always fails .contains(), so the
  // click looked "outside" and closed the panel it was just opened from.
  document.addEventListener('click', e => {
    if (!open || isEmbedMode()) return;
    const navBtn = document.getElementById('ii-chat-btn');
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.includes(panel) && !(navBtn && path.includes(navBtn))) {
      setOpen(false);
    }
  });

  window.iiToggleChat = () => setOpen(!open);

  applyResponsiveMode();
  embedMq.addEventListener('change', applyResponsiveMode);

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

  // Live Polymarket results the AI Informant pulled for this reply (see
  // search_prediction_markets in api/chat.js). Odds only, no analysis: the
  // footer link opens the same search on the Prediction Markets page.
  function escHtml(v) {
    return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmtVol(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
    return `$${n}`;
  }
  function renderMarketCards(markets, query) {
    const wrap = document.createElement('div');
    wrap.className = 'ii-mkts';
    wrap.innerHTML = markets.map(m => {
      const meta = [`${fmtVol(m.volume24h)} 24h vol`];
      if (m.daysLeft != null) meta.push(m.daysLeft <= 0 ? 'closes today' : `${m.daysLeft} day${m.daysLeft === 1 ? '' : 's'} left`);
      return `<div class="ii-mkt">
        <div class="ii-mkt-body">
          <div class="ii-mkt-title">${escHtml(m.question || m.title)}</div>
          <div class="ii-mkt-meta">${escHtml(meta.join(' · '))}</div>
        </div>
        <div class="ii-mkt-odds">${escHtml(m.yesPrice)}%<span>${escHtml(m.outcomeName || 'Yes')}</span></div>
      </div>`;
    }).join('');
    if (query) {
      const link = document.createElement('a');
      link.className = 'ii-mkts-all';
      link.href = `/markets.html?q=${encodeURIComponent(query)}`;
      link.textContent = 'See all results on Prediction Markets →';
      wrap.appendChild(link);
    }
    return wrap;
  }

  function addMsg(role, text, imagePreviews, markets, marketQuery) {
    if (role === 'user') {
      const d = document.createElement('div');
      d.className = 'ii-m ii-m-user';
      if (imagePreviews && imagePreviews.length) {
        const row = document.createElement('div');
        row.className = 'ii-msg-images';
        imagePreviews.forEach(src => {
          const im = document.createElement('img');
          im.src = src;
          im.alt = '';
          row.appendChild(im);
        });
        d.appendChild(row);
      }
      if (text) d.appendChild(document.createTextNode(text));
      msgsEl.appendChild(d);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      return d;
    }
    const row = document.createElement('div');
    row.className = 'ii-row';
    const bubble = document.createElement('div');
    bubble.className = 'ii-m ii-m-ai';
    bubble.innerHTML = mdToHtml(text);
    if (Array.isArray(markets) && markets.length) bubble.appendChild(renderMarketCards(markets, marketQuery));
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
    const imagesToSend = attachedImages;
    if ((!text && !imagesToSend.length) || busy) return;

    startersEl?.remove();
    inp.value = '';
    inp.style.height = 'auto';
    addMsg('user', text, imagesToSend.map(img => img.previewUrl));
    attachedImages = [];
    renderAttachRow();

    // Auth gate — require sign-in
    const token = await window._auth?.getToken();
    if (!token) {
      addMsg('assistant', '**AI Informant requires an infoblade account.**\n\nCreating a free profile takes about 10 seconds — click the account icon in the top-right corner to get started.');
      return;
    }

    busy = true;
    sendBtn.disabled = true;

    history.push({ role: 'user', content: text || '(image attached)' });
    if (!sessionId) sessionId = `cs_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    const thinking = addThinking();
    let bubble = null;
    let raw = '';

    // Lazily swaps the "Thinking…" row for the real message bubble the
    // moment the first token arrives — same avatar hand-off order as
    // addMsg: move the avatar into the new row first, only then is it
    // safe to remove the old one.
    const ensureBubble = () => {
      if (bubble) return;
      const row = document.createElement('div');
      row.className = 'ii-row';
      bubble = document.createElement('div');
      bubble.className = 'ii-m ii-m-ai';
      row.appendChild(bubble);
      msgsEl.appendChild(row);
      moveAvatarTo(row, false);
      thinking.remove();
      msgsEl.scrollTop = msgsEl.scrollHeight;
    };

    try {
      const res = await fetch(window.API_BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          messages: history,
          pageContext,
          sessionId,
          images: imagesToSend.map(img => ({ mediaType: img.mediaType, data: img.data })),
        }),
        signal: AbortSignal.timeout(35000)
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        ensureBubble();
        raw = data.error || 'Something went wrong. Try again.';
        bubble.innerHTML = mdToHtml(raw);
        busy = false;
        sendBtn.disabled = false;
        inp.focus();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let finalMarkets = null, finalQuery = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }

          if (evt.type === 'text') {
            ensureBubble();
            raw += evt.text;
            bubble.innerHTML = mdToHtml(raw) + '<span class="ii-cursor"></span>';
            msgsEl.scrollTop = msgsEl.scrollHeight;
          } else if (evt.type === 'status') {
            const shimmer = thinking.querySelector('.ii-thinking-shimmer');
            if (shimmer) shimmer.textContent = evt.text;
          } else if (evt.type === 'error') {
            ensureBubble();
            raw = evt.error || 'Something went wrong. Try again.';
            bubble.innerHTML = mdToHtml(raw);
          } else if (evt.type === 'done') {
            finalMarkets = evt.markets;
            finalQuery = evt.marketQuery;
          }
        }
      }

      ensureBubble();
      bubble.innerHTML = mdToHtml(raw || 'Something went wrong. Try again.'); // drop the trailing cursor
      if (Array.isArray(finalMarkets) && finalMarkets.length) {
        bubble.appendChild(renderMarketCards(finalMarkets, finalQuery));
      }
      msgsEl.scrollTop = msgsEl.scrollHeight;
      history.push({ role: 'assistant', content: raw });
    } catch (e) {
      const fallback = e.name === 'TimeoutError'
        ? 'The request timed out. Please try again.'
        : 'Connection error. Please try again.';
      if (bubble) {
        bubble.innerHTML = mdToHtml(raw || fallback);
      } else {
        addMsg('assistant', fallback);
        thinking.remove();
      }
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

  // ── History (clock icon) ─────────────────────────────────────────────────
  // Account-synced, last 7 days — see api/chat-history.js. The panel swaps
  // in for .ii-msgs rather than overlaying it; there's no separate scroll
  // area to manage and nothing to click outside of to dismiss.
  function formatHistoryWhen(iso) {
    const d = new Date(iso);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function setHistoryOpen(v) {
    historyOpen = v;
    historyPanel.hidden = !v;
    msgsEl.hidden = v;
  }

  async function loadHistoryList() {
    historyList.innerHTML = '';
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'ii-history-empty';
    emptyMsg.textContent = 'Loading…';
    historyList.appendChild(emptyMsg);

    const token = await window._auth?.getToken();
    if (!token) { emptyMsg.textContent = 'Sign in to see your chat history.'; return; }

    try {
      const res = await fetch(window.API_BASE + '/api/chat-history', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      const sessions = data.sessions || [];
      if (!sessions.length) { emptyMsg.textContent = 'No conversations in the last 7 days.'; return; }
      historyList.innerHTML = '';
      sessions.forEach(s => {
        const btn = document.createElement('button');
        btn.className = 'ii-history-item';
        const preview = document.createElement('span');
        preview.className = 'ii-history-item-preview';
        preview.textContent = s.preview || '(empty)';
        const when = document.createElement('span');
        when.className = 'ii-history-item-date';
        when.textContent = formatHistoryWhen(s.last_at);
        btn.appendChild(preview);
        btn.appendChild(when);
        btn.addEventListener('click', () => loadSession(s.session_id));
        historyList.appendChild(btn);
      });
    } catch (e) {
      emptyMsg.textContent = 'Could not load history.';
    }
  }

  async function loadSession(id) {
    const token = await window._auth?.getToken();
    if (!token) return;
    try {
      const res = await fetch(window.API_BASE + '/api/chat-history?session_id=' + encodeURIComponent(id), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      const msgs = data.messages || [];
      startersEl?.remove();
      msgsEl.innerHTML = '';
      history = msgs.map(m => ({ role: m.role, content: m.content }));
      sessionId = id;
      msgs.forEach(m => addMsg(m.role === 'user' ? 'user' : 'assistant', m.content));
      setHistoryOpen(false);
    } catch (e) { /* leave the history list open on failure */ }
  }

  function startNewChat() {
    startersEl?.remove();
    msgsEl.innerHTML = '';
    history = [];
    sessionId = null;
    startersEl = buildStarters();
    msgsEl.appendChild(startersEl);
    setHistoryOpen(false);
  }

  historyBtn.addEventListener('click', () => {
    setHistoryOpen(!historyOpen);
    if (historyOpen) loadHistoryList();
  });
  historyNewBtn.addEventListener('click', startNewChat);
})();
