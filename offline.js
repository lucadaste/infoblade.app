(function () {
  const BANNER_ID = 'ii-offline-banner';

  function getBanner() { return document.getElementById(BANNER_ID); }

  function createBanner() {
    if (getBanner()) return;
    const el = document.createElement('div');
    el.id = BANNER_ID;
    el.setAttribute('role', 'alert');
    el.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:8px">
        <span style="width:8px;height:8px;border-radius:50%;background:#ff9800;flex-shrink:0"></span>
        No internet connection. Some data may be unavailable
      </span>
      <button onclick="window.location.reload()" style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;font-family:'DM Sans',sans-serif;font-size:12px;font-weight:500;padding:4px 12px;border-radius:4px;cursor:pointer;white-space:nowrap">
        Retry
      </button>`;
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '0',
      left: '0',
      right: '0',
      background: '#1a1a1a',
      borderTop: '1px solid #333',
      color: '#e8e6e0',
      fontFamily: "'DM Sans', sans-serif",
      fontSize: '13px',
      fontWeight: '500',
      padding: '12px 20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      zIndex: '9999',
      transform: 'translateY(100%)',
      transition: 'transform 0.25s ease',
      // Sit above mobile bottom nav (72px) when it's visible
      paddingBottom: 'max(12px, calc(env(safe-area-inset-bottom, 0px) + 12px))',
    });
    document.body.appendChild(el);
    // Animate in
    requestAnimationFrame(() => { el.style.transform = 'translateY(0)'; });
  }

  function showBanner() {
    // Shift bottom nav up if present
    const mobileNav = document.querySelector('.bottom-nav');
    if (mobileNav) mobileNav.style.bottom = '53px';
    createBanner();
  }

  function hideBanner() {
    const el = getBanner();
    if (!el) return;
    // Restore mobile nav
    const mobileNav = document.querySelector('.bottom-nav');
    if (mobileNav) mobileNav.style.bottom = '';
    el.style.transform = 'translateY(100%)';
    setTimeout(() => el.remove(), 300);

    // Flash a brief "back online" confirmation
    const toast = document.createElement('div');
    toast.textContent = 'Back online';
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0,230,118,0.15)',
      border: '1px solid rgba(0,230,118,0.3)',
      color: '#00e676',
      fontFamily: "'DM Sans', sans-serif",
      fontSize: '13px',
      fontWeight: '600',
      padding: '8px 18px',
      borderRadius: '20px',
      zIndex: '9999',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 0.2s',
    });
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 200);
    }, 2500);
  }

  function isOfflineError(err) {
    if (!navigator.onLine) return true;
    const msg = (err?.message || '').toLowerCase();
    return msg.includes('failed to fetch') || msg.includes('network') || msg.includes('load failed');
  }

  // Expose helper so page scripts can call window.offlineMessage(err)
  // to get a user-friendly string instead of a raw error
  window.getOfflineAwareMessage = function (err) {
    if (isOfflineError(err)) return 'No internet connection. Check your connection and try again.';
    return err?.message || 'Something went wrong. Please try again.';
  };

  // Init state
  if (!navigator.onLine) showBanner();
  window.addEventListener('offline', showBanner);
  window.addEventListener('online', hideBanner);
})();
