(function () {
  const STORAGE_KEY = 'ii_onboarded_v1';
  if (localStorage.getItem(STORAGE_KEY)) return;

  const SLIDES = [
    {
      icon: `<svg width="30" height="37" viewBox="16 23 310 388" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" fill="var(--ob-accent)" d="M 77 24.258 C 77 24.950, 80.019 27.537, 83.709 30.008 C 91.878 35.477, 111.820 54.509, 116.048 60.870 C 117.741 63.417, 119.639 67.408, 120.267 69.740 C 121.584 74.627, 120.561 74.165, 141.500 79.312 C 157.225 83.177, 164.663 84.355, 165.437 83.102 C 166.819 80.866, 141.659 60.509, 117 43.912 C 112.120 40.628, 78.840 23, 77.519 23 C 77.233 23, 77 23.566, 77 24.258 M 22.072 82.022 C 19.636 82.536, 17.254 83.346, 16.777 83.823 C 15.974 84.626, 18.360 85.170, 35.500 88.088 C 42.381 89.260, 52.366 91.925, 66 96.229 C 73.747 98.675, 168.701 135.953, 189 144.518 C 192.025 145.794, 199.900 148.947, 206.500 151.525 C 223.306 158.088, 242.564 168.103, 248.626 173.432 C 260.872 184.198, 263.097 193.015, 257.096 207 C 255.326 211.125, 252.754 217.200, 251.381 220.500 C 250.008 223.800, 248.027 228.525, 246.980 231 C 245.933 233.475, 242.331 242.025, 238.977 250 C 235.623 257.975, 231.478 267.755, 229.766 271.733 C 226.251 279.902, 225.973 277.689, 232.936 297 C 235.217 303.325, 240.179 317.500, 243.964 328.500 C 252.501 353.313, 258.739 370.768, 259.522 372.036 C 259.901 372.649, 244.161 373, 216.264 373 L 172.411 373 150.955 390.968 C 139.155 400.850, 129.500 409.512, 129.500 410.218 C 129.500 411.249, 143.477 411.500, 200.858 411.500 L 272.216 411.500 282.197 403 C 287.686 398.325, 294.025 393.017, 296.284 391.205 C 298.542 389.392, 302.591 385.850, 305.282 383.333 L 310.174 378.757 307.661 371.128 C 306.279 366.933, 302.370 355.625, 298.974 346 C 295.579 336.375, 289.514 319.050, 285.498 307.500 C 281.481 295.950, 277.718 285.279, 277.136 283.786 C 276.272 281.573, 276.510 280.099, 278.425 275.786 C 279.716 272.879, 283.106 264.875, 285.958 258 C 288.810 251.125, 293.333 240.325, 296.009 234 C 298.684 227.675, 303.619 215.975, 306.975 208 C 310.330 200.025, 313.943 191.475, 315.002 189 C 324.190 167.542, 326.983 160.397, 326.586 159.362 C 325.203 155.760, 292.893 138.471, 274.500 131.491 C 262.871 127.078, 226.856 116.175, 204.689 110.356 C 196.469 108.199, 170.171 103.049, 156.500 100.920 C 153.200 100.406, 145.775 98.879, 140 97.527 C 128.326 94.793, 116.390 92.763, 95.500 89.957 C 78.174 87.630, 57.967 84.449, 51.967 83.105 C 45.278 81.606, 27.153 80.949, 22.072 82.022 M 122 261.500 C 122 328.325, 122.244 383, 122.542 383 C 122.840 383, 131.278 376.134, 141.292 367.743 C 151.306 359.351, 160.730 351.529, 162.234 350.361 L 164.968 348.237 165 261.369 C 165.018 213.591, 165.025 170.155, 165.016 164.844 L 165 155.188 160.750 153.664 C 158.412 152.826, 152.900 150.737, 148.500 149.023 C 133.559 143.201, 124.621 140, 123.309 140 C 122.238 140, 122 162.065, 122 261.500"/></svg>`,
      accent: 'var(--accent)',
      heading: 'Welcome to infoblade',
      body: 'Market intelligence, reimagined. Real-time news analysis, stock predictions, and a live track record of accuracy.',
      cta: 'Get Started',
    },
    {
      icon: `<svg width="30" height="30" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="12" y="20" width="32" height="4" rx="2" fill="var(--ob-accent)" opacity="0.7"/>
        <rect x="12" y="28" width="24" height="4" rx="2" fill="var(--ob-accent)" opacity="0.5"/>
        <rect x="12" y="36" width="18" height="4" rx="2" fill="var(--ob-accent)" opacity="0.3"/>
        <circle cx="44" cy="16" r="5" fill="var(--ob-accent)"/>
        <path d="M42 16l1.5 1.5L46 14" stroke="#0a0f0c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`,
      accent: 'var(--accent)',
      heading: 'How It Works',
      body: null,
      bullets: [
        'We scan financial news and surface what matters most',
        'We analyze market impact and predict winners and losers',
        'Every prediction is tracked so you can see our accuracy over time',
      ],
      cta: 'Next',
    },
    {
      icon: `<svg width="26" height="30" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M28 14l2.5 7.5H38l-6.5 4.5 2.5 7.5L28 29l-6 4.5 2.5-7.5L19 21.5h7.5z" stroke="var(--ob-accent)" stroke-width="1.8" stroke-linejoin="round" fill="none"/>
        <line x1="28" y1="36" x2="28" y2="42" stroke="var(--ob-accent)" stroke-width="2" stroke-linecap="round"/>
        <circle cx="28" cy="44" r="1.5" fill="var(--ob-accent)"/>
      </svg>`,
      accent: '#ff9800',
      heading: 'Important Notice',
      body: 'infoblade provides analysis for informational purposes only. Nothing here is financial advice. Always do your own research before making investment decisions. Past accuracy does not guarantee future results.',
      cta: "I Understand, Let's Go",
      ctaAccent: true,
      final: true,
    },
  ];

  let current = 0;

  // ── Stylesheet ─────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #ii-onboarding {
      position: fixed; inset: 0; z-index: 10000;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
      background: radial-gradient(circle at 50% 32%, rgba(0,230,118,0.08), transparent 60%), rgba(4,7,6,0.86);
      backdrop-filter: blur(20px) saturate(140%);
      -webkit-backdrop-filter: blur(20px) saturate(140%);
      opacity: 0; transition: opacity 0.3s ease;
      touch-action: none;
    }
    .ii-ob-card {
      position: relative;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 22px;
      width: 100%; max-width: 400px;
      padding: 36px 30px 30px;
      font-family: 'DM Sans', sans-serif;
      box-shadow: 0 24px 70px -12px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.02) inset;
      transform: scale(0.94) translateY(10px);
      opacity: 0;
      transition: transform 0.4s cubic-bezier(0.16,1,0.3,1), opacity 0.3s ease;
      overflow: hidden;
    }
    .ii-ob-card::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 140px;
      background: radial-gradient(ellipse at 50% 0%, rgba(0,230,118,0.10), transparent 70%);
      pointer-events: none;
    }
    #ii-onboarding.ii-ob-show { opacity: 1; }
    #ii-onboarding.ii-ob-show .ii-ob-card { opacity: 1; transform: scale(1) translateY(0); }
    .ii-ob-dots { display: flex; justify-content: center; gap: 6px; margin-bottom: 26px; position: relative; z-index: 1; }
    .ii-ob-dot { height: 5px; border-radius: 3px; width: 6px; background: var(--divider); transition: width 0.3s cubic-bezier(0.4,0,0.2,1), background 0.3s ease; }
    .ii-ob-dot.active { width: 22px; background: var(--ob-accent, var(--accent)); }
    .ii-ob-icon-wrap { display: flex; justify-content: center; margin-bottom: 22px; position: relative; z-index: 1; }
    .ii-ob-icon {
      width: 60px; height: 60px; border-radius: 16px;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(155deg, color-mix(in srgb, var(--ob-accent) 16%, transparent), color-mix(in srgb, var(--ob-accent) 4%, transparent));
      border: 1px solid color-mix(in srgb, var(--ob-accent) 30%, transparent);
      box-shadow: 0 0 0 1px rgba(255,255,255,0.02) inset, 0 8px 20px -8px color-mix(in srgb, var(--ob-accent) 45%, transparent);
    }
    .ii-ob-heading { margin: 0 0 12px; font-size: 21px; font-weight: 700; color: var(--ink); text-align: center; line-height: 1.3; letter-spacing: -0.2px; position: relative; z-index: 1; }
    .ii-ob-body-wrap { margin-bottom: 26px; min-height: 76px; position: relative; z-index: 1; }
    .ii-ob-body-wrap p { margin: 0; font-size: 14.5px; line-height: 1.65; color: var(--muted); text-align: center; }
    .ii-ob-bullets { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 13px; }
    .ii-ob-bullets li { display: flex; align-items: flex-start; gap: 11px; font-size: 14.5px; line-height: 1.5; color: var(--text-soft); }
    .ii-ob-bullets li .dash { color: var(--ob-accent, var(--accent)); flex-shrink: 0; margin-top: 2px; font-size: 10px; font-weight: 700; }
    .ii-ob-btn {
      width: 100%; padding: 14px; border-radius: 12px; border: 1px solid transparent;
      font-size: 15px; font-family: 'DM Sans', sans-serif; font-weight: 600; cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.2s ease, filter 0.15s ease, background 0.2s ease;
      position: relative; z-index: 1;
      background: var(--surface-2); color: var(--ink); border-color: var(--border);
    }
    .ii-ob-btn:hover { filter: brightness(1.08); }
    .ii-ob-btn:active { transform: scale(0.98); }
    .ii-ob-btn.ii-ob-btn-accent {
      background: var(--ob-accent, var(--accent)); color: #0a0f0c; border-color: transparent;
      box-shadow: 0 8px 24px -8px color-mix(in srgb, var(--ob-accent) 60%, transparent);
    }
    .ii-ob-btn.ii-ob-btn-accent:hover { box-shadow: 0 10px 28px -6px color-mix(in srgb, var(--ob-accent) 70%, transparent); }
    @media (max-width: 420px) {
      .ii-ob-card { padding: 30px 24px 24px; border-radius: 20px; }
    }
  `;
  document.head.appendChild(style);

  // ── Overlay shell ──────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'ii-onboarding';

  const card = document.createElement('div');
  card.className = 'ii-ob-card';

  const dotsRow = document.createElement('div');
  dotsRow.className = 'ii-ob-dots';
  const dots = SLIDES.map((_, i) => {
    const d = document.createElement('div');
    d.className = 'ii-ob-dot' + (i === 0 ? ' active' : '');
    return d;
  });
  dots.forEach(d => dotsRow.appendChild(d));

  const iconWrap = document.createElement('div');
  iconWrap.className = 'ii-ob-icon-wrap';
  const iconBox = document.createElement('div');
  iconBox.className = 'ii-ob-icon';
  iconWrap.appendChild(iconBox);

  const heading = document.createElement('h2');
  heading.className = 'ii-ob-heading';

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'ii-ob-body-wrap';

  const btn = document.createElement('button');
  btn.className = 'ii-ob-btn';

  card.appendChild(dotsRow);
  card.appendChild(iconWrap);
  card.appendChild(heading);
  card.appendChild(bodyWrap);
  card.appendChild(btn);
  overlay.appendChild(card);

  // ── Render slide ───────────────────────────────────────────────
  function paintSlide(idx) {
    const slide = SLIDES[idx];
    card.style.setProperty('--ob-accent', slide.accent);

    iconBox.innerHTML = slide.icon;
    heading.textContent = slide.heading;

    bodyWrap.innerHTML = '';
    if (slide.body) {
      const p = document.createElement('p');
      p.textContent = slide.body;
      bodyWrap.appendChild(p);
    }
    if (slide.bullets) {
      const ul = document.createElement('ul');
      ul.className = 'ii-ob-bullets';
      slide.bullets.forEach(text => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="dash">–</span><span>${text}</span>`;
        ul.appendChild(li);
      });
      bodyWrap.appendChild(ul);
    }

    btn.textContent = slide.cta;
    btn.classList.toggle('ii-ob-btn-accent', !!slide.ctaAccent);

    dots.forEach((d, i) => d.classList.toggle('active', i === idx));
  }

  function renderSlide(idx, direction) {
    card.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
    card.style.opacity = '0';
    card.style.transform = `translateY(${direction > 0 ? '14px' : '-14px'}) scale(0.98)`;

    setTimeout(() => {
      paintSlide(idx);
      card.style.transition = 'opacity 0.25s ease, transform 0.3s cubic-bezier(0.16,1,0.3,1)';
      card.style.opacity = '1';
      card.style.transform = 'translateY(0) scale(1)';
    }, 180);
  }

  btn.addEventListener('click', () => {
    if (current < SLIDES.length - 1) {
      current++;
      renderSlide(current, 1);
    } else {
      dismiss();
    }
  });

  // ── Scroll lock ────────────────────────────────────────────────
  const scrollY = window.scrollY || window.pageYOffset || 0;
  const prevHtmlOverflow = document.documentElement.style.overflow;
  const prevBodyOverflow = document.body.style.overflow;
  const prevBodyPosition = document.body.style.position;
  const prevBodyTop = document.body.style.top;
  const prevBodyWidth = document.body.style.width;

  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  document.body.style.position = 'fixed';
  document.body.style.top = `-${scrollY}px`;
  document.body.style.width = '100%';

  function unlockScroll() {
    document.documentElement.style.overflow = prevHtmlOverflow;
    document.body.style.overflow = prevBodyOverflow;
    document.body.style.position = prevBodyPosition;
    document.body.style.top = prevBodyTop;
    document.body.style.width = prevBodyWidth;
    window.scrollTo(0, scrollY);
  }

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, '1');
    overlay.classList.remove('ii-ob-show');
    setTimeout(() => {
      overlay.remove();
      style.remove();
      unlockScroll();
    }, 300);
  }

  // ── Mount ──────────────────────────────────────────────────────
  document.body.appendChild(overlay);
  paintSlide(0);

  requestAnimationFrame(() => {
    overlay.classList.add('ii-ob-show');
  });
})();
