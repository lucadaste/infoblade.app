(function () {
  const STORAGE_KEY = 'ii_onboarded_v1';
  if (localStorage.getItem(STORAGE_KEY)) return;

  const SLIDES = [
    {
      icon: `<svg width="56" height="56" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="56" height="56" rx="14" fill="rgba(0,230,118,0.12)"/>
        <svg x="13.5" y="10" width="29" height="36" viewBox="16 23 310 388"><path fill-rule="evenodd" fill="#00e676" d="M 77 24.258 C 77 24.950, 80.019 27.537, 83.709 30.008 C 91.878 35.477, 111.820 54.509, 116.048 60.870 C 117.741 63.417, 119.639 67.408, 120.267 69.740 C 121.584 74.627, 120.561 74.165, 141.500 79.312 C 157.225 83.177, 164.663 84.355, 165.437 83.102 C 166.819 80.866, 141.659 60.509, 117 43.912 C 112.120 40.628, 78.840 23, 77.519 23 C 77.233 23, 77 23.566, 77 24.258 M 22.072 82.022 C 19.636 82.536, 17.254 83.346, 16.777 83.823 C 15.974 84.626, 18.360 85.170, 35.500 88.088 C 42.381 89.260, 52.366 91.925, 66 96.229 C 73.747 98.675, 168.701 135.953, 189 144.518 C 192.025 145.794, 199.900 148.947, 206.500 151.525 C 223.306 158.088, 242.564 168.103, 248.626 173.432 C 260.872 184.198, 263.097 193.015, 257.096 207 C 255.326 211.125, 252.754 217.200, 251.381 220.500 C 250.008 223.800, 248.027 228.525, 246.980 231 C 245.933 233.475, 242.331 242.025, 238.977 250 C 235.623 257.975, 231.478 267.755, 229.766 271.733 C 226.251 279.902, 225.973 277.689, 232.936 297 C 235.217 303.325, 240.179 317.500, 243.964 328.500 C 252.501 353.313, 258.739 370.768, 259.522 372.036 C 259.901 372.649, 244.161 373, 216.264 373 L 172.411 373 150.955 390.968 C 139.155 400.850, 129.500 409.512, 129.500 410.218 C 129.500 411.249, 143.477 411.500, 200.858 411.500 L 272.216 411.500 282.197 403 C 287.686 398.325, 294.025 393.017, 296.284 391.205 C 298.542 389.392, 302.591 385.850, 305.282 383.333 L 310.174 378.757 307.661 371.128 C 306.279 366.933, 302.370 355.625, 298.974 346 C 295.579 336.375, 289.514 319.050, 285.498 307.500 C 281.481 295.950, 277.718 285.279, 277.136 283.786 C 276.272 281.573, 276.510 280.099, 278.425 275.786 C 279.716 272.879, 283.106 264.875, 285.958 258 C 288.810 251.125, 293.333 240.325, 296.009 234 C 298.684 227.675, 303.619 215.975, 306.975 208 C 310.330 200.025, 313.943 191.475, 315.002 189 C 324.190 167.542, 326.983 160.397, 326.586 159.362 C 325.203 155.760, 292.893 138.471, 274.500 131.491 C 262.871 127.078, 226.856 116.175, 204.689 110.356 C 196.469 108.199, 170.171 103.049, 156.500 100.920 C 153.200 100.406, 145.775 98.879, 140 97.527 C 128.326 94.793, 116.390 92.763, 95.500 89.957 C 78.174 87.630, 57.967 84.449, 51.967 83.105 C 45.278 81.606, 27.153 80.949, 22.072 82.022 M 122 261.500 C 122 328.325, 122.244 383, 122.542 383 C 122.840 383, 131.278 376.134, 141.292 367.743 C 151.306 359.351, 160.730 351.529, 162.234 350.361 L 164.968 348.237 165 261.369 C 165.018 213.591, 165.025 170.155, 165.016 164.844 L 165 155.188 160.750 153.664 C 158.412 152.826, 152.900 150.737, 148.500 149.023 C 133.559 143.201, 124.621 140, 123.309 140 C 122.238 140, 122 162.065, 122 261.500"/></svg>
      </svg>`,
      heading: 'Welcome',
      body: 'Market intelligence. Real-time news analysis, stock predictions, and a live track record of accuracy.',
      cta: 'Get Started',
    },
    {
      icon: `<svg width="56" height="56" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="56" height="56" rx="14" fill="rgba(0,230,118,0.12)"/>
        <rect x="12" y="20" width="32" height="4" rx="2" fill="#00e676" opacity="0.7"/>
        <rect x="12" y="28" width="24" height="4" rx="2" fill="#00e676" opacity="0.5"/>
        <rect x="12" y="36" width="18" height="4" rx="2" fill="#00e676" opacity="0.3"/>
        <circle cx="44" cy="16" r="5" fill="#00e676"/>
        <path d="M42 16l1.5 1.5L46 14" stroke="#1a1a1a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`,
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
      icon: `<svg width="56" height="56" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="56" height="56" rx="14" fill="rgba(255,152,0,0.12)"/>
        <path d="M28 14l2.5 7.5H38l-6.5 4.5 2.5 7.5L28 29l-6 4.5 2.5-7.5L19 21.5h7.5z" stroke="#ff9800" stroke-width="1.8" stroke-linejoin="round" fill="none"/>
        <line x1="28" y1="36" x2="28" y2="42" stroke="#ff9800" stroke-width="2" stroke-linecap="round"/>
        <circle cx="28" cy="44" r="1.5" fill="#ff9800"/>
      </svg>`,
      heading: 'Important Notice',
      body: 'infoblade provides analysis for informational purposes only. Nothing here is financial advice. Always do your own research before making investment decisions. Past accuracy does not guarantee future results.',
      cta: 'I Understand, Let\'s Go',
      ctaAccent: true,
      final: true,
    },
  ];

  let current = 0;

  // ── Overlay shell ──────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'ii-onboarding';
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    background: 'rgba(0,0,0,0.92)',
    backdropFilter: 'blur(8px)',
    zIndex: '10000',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    padding: '0',
    opacity: '0',
    transition: 'opacity 0.3s ease',
  });

  // ── Card ───────────────────────────────────────────────────────
  const card = document.createElement('div');
  Object.assign(card.style, {
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: '24px 24px 0 0',
    width: '100%',
    maxWidth: '480px',
    padding: '32px 28px 40px',
    fontFamily: "'DM Sans', sans-serif",
    transform: 'translateY(40px)',
    transition: 'transform 0.35s cubic-bezier(0.34,1.26,0.64,1)',
    boxSizing: 'border-box',
  });

  // ── Dots ───────────────────────────────────────────────────────
  const dotsRow = document.createElement('div');
  Object.assign(dotsRow.style, {
    display: 'flex',
    justifyContent: 'center',
    gap: '6px',
    marginBottom: '28px',
  });
  const dots = SLIDES.map((_, i) => {
    const d = document.createElement('div');
    Object.assign(d.style, {
      width: i === 0 ? '20px' : '6px',
      height: '6px',
      borderRadius: '3px',
      background: i === 0 ? '#00e676' : '#333',
      transition: 'width 0.25s ease, background 0.25s ease',
    });
    return d;
  });
  dots.forEach(d => dotsRow.appendChild(d));

  // ── Icon ───────────────────────────────────────────────────────
  const iconWrap = document.createElement('div');
  Object.assign(iconWrap.style, {
    marginBottom: '20px',
    display: 'flex',
    justifyContent: 'center',
  });

  // ── Heading ────────────────────────────────────────────────────
  const heading = document.createElement('h2');
  Object.assign(heading.style, {
    margin: '0 0 14px',
    fontSize: '22px',
    fontWeight: '700',
    color: '#e8e6e0',
    textAlign: 'center',
    lineHeight: '1.3',
  });

  // ── Body / bullets ─────────────────────────────────────────────
  const bodyWrap = document.createElement('div');
  Object.assign(bodyWrap.style, {
    marginBottom: '28px',
    minHeight: '80px',
  });

  // ── CTA button ────────────────────────────────────────────────
  const btn = document.createElement('button');
  Object.assign(btn.style, {
    width: '100%',
    padding: '15px',
    borderRadius: '12px',
    border: 'none',
    fontSize: '16px',
    fontFamily: "'DM Sans', sans-serif",
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  });
  btn.addEventListener('mousedown', () => { btn.style.opacity = '0.8'; });
  btn.addEventListener('mouseup', () => { btn.style.opacity = '1'; });

  card.appendChild(dotsRow);
  card.appendChild(iconWrap);
  card.appendChild(heading);
  card.appendChild(bodyWrap);
  card.appendChild(btn);
  overlay.appendChild(card);

  // ── Render slide ───────────────────────────────────────────────
  function renderSlide(idx, direction) {
    const slide = SLIDES[idx];

    // Animate card out then in
    card.style.opacity = '0';
    card.style.transform = `translateY(${direction > 0 ? '30px' : '-30px'})`;

    setTimeout(() => {
      // Icon
      iconWrap.innerHTML = slide.icon;

      // Heading
      heading.textContent = slide.heading;
      heading.style.color = slide.final ? '#ff9800' : '#e8e6e0';

      // Body
      bodyWrap.innerHTML = '';
      if (slide.body) {
        const p = document.createElement('p');
        Object.assign(p.style, {
          margin: '0',
          fontSize: '15px',
          lineHeight: '1.65',
          color: slide.final ? '#c8a97a' : '#999',
          textAlign: 'center',
        });
        p.textContent = slide.body;
        bodyWrap.appendChild(p);
      }
      if (slide.bullets) {
        const ul = document.createElement('ul');
        Object.assign(ul.style, {
          margin: '0',
          padding: '0',
          listStyle: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        });
        slide.bullets.forEach(text => {
          const li = document.createElement('li');
          Object.assign(li.style, {
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            fontSize: '15px',
            lineHeight: '1.5',
            color: '#bbb',
          });
          li.innerHTML = `<span style="color:#00e676;flex-shrink:0;margin-top:2px;font-size:10px;font-weight:700;letter-spacing:0.5px">–</span><span>${text}</span>`;
          ul.appendChild(li);
        });
        bodyWrap.appendChild(ul);
      }

      // Button
      btn.textContent = slide.cta;
      if (slide.ctaAccent) {
        Object.assign(btn.style, { background: '#00e676', color: '#111' });
      } else {
        Object.assign(btn.style, { background: '#222', color: '#e8e6e0' });
      }

      // Dots
      dots.forEach((d, i) => {
        d.style.width = i === idx ? '20px' : '6px';
        d.style.background = i === idx ? '#00e676' : '#333';
      });

      card.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      card.style.opacity = '1';
      card.style.transform = 'translateY(0)';
    }, 200);
  }

  btn.addEventListener('click', () => {
    if (current < SLIDES.length - 1) {
      current++;
      renderSlide(current, 1);
    } else {
      dismiss();
    }
  });

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, '1');
    overlay.style.opacity = '0';
    card.style.transform = 'translateY(60px)';
    setTimeout(() => overlay.remove(), 350);
  }

  // ── Mount ──────────────────────────────────────────────────────
  document.body.appendChild(overlay);

  // Initial render (no animation direction needed)
  iconWrap.innerHTML = SLIDES[0].icon;
  heading.textContent = SLIDES[0].heading;
  const p0 = document.createElement('p');
  Object.assign(p0.style, {
    margin: '0',
    fontSize: '15px',
    lineHeight: '1.65',
    color: '#999',
    textAlign: 'center',
  });
  p0.textContent = SLIDES[0].body;
  bodyWrap.appendChild(p0);
  btn.textContent = SLIDES[0].cta;
  Object.assign(btn.style, { background: '#222', color: '#e8e6e0' });

  // Animate in
  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
    card.style.transform = 'translateY(0)';
  });
})();
