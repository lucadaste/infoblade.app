(function () {
  const STORAGE_KEY = 'ii_onboarded_v1';
  if (localStorage.getItem(STORAGE_KEY)) return;

  const SLIDES = [
    {
      icon: `<svg width="56" height="56" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="56" height="56" rx="14" fill="rgba(0,230,118,0.12)"/>
        <polyline points="10,38 22,24 30,30 42,14" stroke="#00e676" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <circle cx="42" cy="14" r="3" fill="#00e676"/>
        <line x1="10" y1="44" x2="46" y2="44" stroke="#00e676" stroke-width="1.5" stroke-linecap="round" opacity="0.4"/>
      </svg>`,
      heading: 'infoblade',
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
