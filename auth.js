(async function () {
  let _readyCallbacks = [];
  let _ready = false;
  let _currentUser = null;
  let _changeCallbacks = [];

  // Exposed synchronously (function declarations are hoisted, so `onReady`
  // below is already callable here) so every page can register a callback
  // the instant this script tag finishes, instead of polling `window._auth`
  // with setTimeout(100) — that poll added up to 100ms of pure dead time to
  // every page load and login-triggered redirect for no reason.
  window._onAuthReady = onReady;

  // onReady only ever fires once (the first time auth resolves) — fine for
  // initial page gating, but it means a page that checked "am I signed in?"
  // on load never finds out if the user later signs out from the account
  // dropdown without leaving the page: the gated content (dashboard, account
  // settings, etc.) just stays on screen. This fires on every subsequent
  // change too, so pages can re-gate themselves live.
  window._onAuthChange = function (fn) { _changeCallbacks.push(fn); };

  // Clicking to another page while this one is still loading Clerk aborts
  // Clerk's in-flight requests, so init "fails" and we'd report a signed-out
  // user — home.html then redirects to '/', hijacking the navigation the user
  // actually asked for and ping-ponging '/' -> '/home.html' (Safari paints a
  // mash-up of all three pages mid-bounce). A page on its way out shouldn't
  // report anything; reset on pageshow so a bfcache restore works normally.
  let _leaving = false;
  window.addEventListener('beforeunload', () => { _leaving = true; });
  window.addEventListener('pagehide', () => { _leaving = true; });
  window.addEventListener('pageshow', () => { _leaving = false; });

  // Inject styles for the account badge + its dropdown
  const _styleEl = document.createElement('style');
  _styleEl.textContent = `
    #auth-badge { display: none; align-items: center; }
    .ib-account-wrap { position: relative; }
    .ib-account-btn {
      width: 34px; height: 34px; border-radius: 50%; padding: 0;
      background: var(--surface-2); color: var(--muted); border: none;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex-shrink: 0; transition: color 0.15s, background 0.15s;
    }
    .ib-account-btn:hover { color: var(--ink); }
    .ib-account-btn.signed-in { color: var(--accent); }
    .ib-account-btn svg { width: 18px; height: 18px; pointer-events: none; }
    .ib-account-btn.has-photo { background: none; }
    .ib-account-btn-img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; pointer-events: none; }
    .ib-account-dropdown {
      display: none; position: absolute; top: calc(100% + 12px); right: 0; min-width: 210px;
      background: var(--card); border: 1px solid var(--border); border-radius: 10px;
      padding: 6px 0; z-index: 250; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    .ib-account-dropdown.open { display: block; }
    .ib-account-info { display: flex; align-items: center; gap: 10px; padding: 10px 18px 12px; border-bottom: 1px solid var(--border); margin-bottom: 2px; }
    .ib-account-info-photo { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
    .ib-account-info-text { min-width: 0; }
    .ib-account-name { font-size: 13px; font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ib-account-email { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ib-menu-item {
      display: flex; align-items: center; gap: 10px; width: 100%;
      padding: 10px 18px; background: none; border: none;
      font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 500;
      color: var(--muted); text-align: left; text-decoration: none; cursor: pointer;
      transition: color 0.15s, background 0.15s;
    }
    .ib-menu-item:hover { color: var(--ink); background: var(--hover-tint, var(--surface-2)); }
    .ib-menu-item.active { color: var(--accent); }
    .ib-menu-item svg { width: 16px; height: 16px; flex-shrink: 0; pointer-events: none; }
    .ib-menu-item span { white-space: nowrap; }
    /* The theme toggle is a secondary utility, not an account action — kept
       in the same dropdown (per product decision) but visually set apart at
       the bottom instead of sitting right under the account info as if it
       were the primary item. */
    .ib-menu-item-theme { border-top: 1px solid var(--border); margin-top: 2px; padding-top: 11px; }
    /* The hamburger menu now lists every section (a fallback for screens where
       the bottom nav bar is cut off) and can reach the mid-screen AI button;
       tuck that button away while either menu is open so it doesn't sit on
       top of it. */
    body:has(.nav-links.open, #nav-menu.open, .ib-account-dropdown.open) #ii-chat-btn { opacity: 0; pointer-events: none; }
  `;
  document.head.appendChild(_styleEl);

  function _escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // A generic person-in-a-circle icon. Rendered immediately (before Clerk even
  // starts loading) so the account icon is on screen at all times — grey while
  // signed out, green once we know the user is signed in — and never depends
  // on Clerk successfully initializing to simply be present.
  const _PERSON_ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="8" r="3.5" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 19c1.4-3.4 4.3-5.2 7.5-5.2s6.1 1.8 7.5 5.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const _SUN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>';
  const _MOON_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/></svg>';

  // Remembering the last known sign-in state lets the menu's Account section
  // render correctly on the next page load instead of flashing "Sign in" until
  // Clerk finishes loading. _updateUI() below keeps this in sync with reality.
  const _SIGNED_IN_CACHE_KEY = 'ii_was_signed_in';
  let _wasSignedIn = false;
  try { _wasSignedIn = localStorage.getItem(_SIGNED_IN_CACHE_KEY) === '1'; } catch (_) {}

  // Same idea for the avatar photo: shows the last-known picture immediately
  // instead of the generic person icon flashing before Clerk resolves.
  const _AVATAR_CACHE_KEY = 'ii_avatar_url';
  let _cachedAvatarUrl = '';
  try { _cachedAvatarUrl = localStorage.getItem(_AVATAR_CACHE_KEY) || ''; } catch (_) {}

  const _GEAR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
  const _SIGNOUT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>';

  function _themeItemState() {
    const isLight = window.__iiTheme ? window.__iiTheme.get() === 'light' : false;
    return isLight ? { icon: _MOON_ICON, text: 'Dark mode' } : { icon: _SUN_ICON, text: 'Light mode' };
  }

  // The hamburger menu (<ul class="nav-links"> on app pages, <div id="nav-menu">
  // on landing) lists every section, mirroring the bottom nav bar — a fallback
  // for screens where that bar is cut off. Theme + account controls instead
  // live under a dedicated account icon in the nav bar itself.
  function _closeBurgerMenu() {
    const menu = document.querySelector('.nav-links') || document.getElementById('nav-menu');
    const burger = document.getElementById('nav-burger');
    if (menu) menu.classList.remove('open');
    if (burger) burger.classList.remove('open');
  }

  function _closeAccountDropdown() {
    const dd = document.getElementById('ib-account-dropdown');
    const btn = document.getElementById('ib-account-btn');
    if (dd) dd.classList.remove('open');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function _accountDropdownHTML(signedIn, user) {
    const t = _themeItemState();
    const photoUrl = (signedIn && user && user.imageUrl) ? user.imageUrl : '';
    const infoHTML = (signedIn && user) ? `
      <div class="ib-account-info">
        ${photoUrl ? `<img class="ib-account-info-photo" src="${_escapeHTML(photoUrl)}" alt="">` : ''}
        <div class="ib-account-info-text">
          <div class="ib-account-name">${_escapeHTML(user.name || user.username || 'Account')}</div>
          ${user.email ? `<div class="ib-account-email">${_escapeHTML(user.email)}</div>` : ''}
        </div>
      </div>` : '';
    const onAccount = location.pathname === '/account.html' || location.pathname === '/account';
    const accountHTML = signedIn
      ? `<a class="ib-menu-item${onAccount ? ' active' : ''}" href="/account.html">${_GEAR_ICON}<span>Account settings</span></a>
         <button class="ib-menu-item" id="ib-menu-signout" type="button">${_SIGNOUT_ICON}<span>Sign out</span></button>`
      : `<button class="ib-menu-item" id="ib-menu-signin" type="button">${_PERSON_ICON}<span>Sign in</span></button>`;
    return `
      ${infoHTML}
      ${accountHTML}
      <button class="ib-menu-item ib-menu-item-theme" id="ib-menu-theme" type="button"><span class="ib-menu-theme-icon">${t.icon}</span><span class="ib-menu-theme-text">${t.text}</span></button>`;
  }

  function _renderAccountDropdown(signedIn) {
    const dd = document.getElementById('ib-account-dropdown');
    if (!dd) return;
    dd.innerHTML = _accountDropdownHTML(signedIn, _currentUser);

    const themeBtn = dd.querySelector('#ib-menu-theme');
    themeBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // keep the dropdown open so the change is visible
      if (window.__iiTheme) window.__iiTheme.toggle();
      const s = _themeItemState();
      themeBtn.querySelector('.ib-menu-theme-icon').innerHTML = s.icon;
      themeBtn.querySelector('.ib-menu-theme-text').textContent = s.text;
    });
    const signInBtn = dd.querySelector('#ib-menu-signin');
    if (signInBtn) signInBtn.addEventListener('click', () => {
      _closeAccountDropdown();
      if (typeof window.__iiOpenSignIn === 'function') window.__iiOpenSignIn();
      else window.location.href = '/?modal=signin';
    });
    const signOutBtn = dd.querySelector('#ib-menu-signout');
    if (signOutBtn) signOutBtn.addEventListener('click', () => { _closeAccountDropdown(); signOut(); });
  }

  function _accountBtnIconHTML(photoUrl) {
    return photoUrl ? `<img class="ib-account-btn-img" src="${_escapeHTML(photoUrl)}" alt="">` : _PERSON_ICON;
  }

  function _renderAccountBadge() {
    const badge = document.getElementById('auth-badge');
    if (!badge) return;
    badge.style.display = 'flex';
    const photoUrl = _wasSignedIn ? _cachedAvatarUrl : '';
    badge.innerHTML = `
      <div class="ib-account-wrap">
        <button class="ib-account-btn${_wasSignedIn ? ' signed-in' : ''}${photoUrl ? ' has-photo' : ''}" id="ib-account-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Account" title="Account">${_accountBtnIconHTML(photoUrl)}</button>
        <div class="ib-account-dropdown" id="ib-account-dropdown"></div>
      </div>`;
    _renderAccountDropdown(_wasSignedIn);

    document.getElementById('ib-account-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      _closeBurgerMenu();
      const dd = document.getElementById('ib-account-dropdown');
      const open = dd.classList.toggle('open');
      e.currentTarget.setAttribute('aria-expanded', String(open));
    });
    // Capture phase (the `true` below), not bubble: the per-page burger
    // button calls e.stopPropagation() on click, which would otherwise stop
    // this from ever seeing that click and the two menus would stay open
    // on top of each other.
    document.addEventListener('click', (e) => {
      const wrap = badge.querySelector('.ib-account-wrap');
      if (wrap && !wrap.contains(e.target)) _closeAccountDropdown();
    }, true);
  }
  _renderAccountBadge();

  function _fireReady() {
    _ready = true;
    _readyCallbacks.forEach(fn => fn(_currentUser));
    _readyCallbacks = [];
  }

  function _noop() { return Promise.reject(new Error('Auth unavailable — please reload the page.')); }
  async function _noopToken() { return null; }
  function _noopReady(fn) { fn(null); }

  // The publishable key is safe to cache client-side (it's the "publishable"
  // half of the keypair, meant to be public) — caching it means most page
  // loads can start injecting the Clerk script immediately instead of
  // waiting on a round trip to /api/config first.
  const _PK_CACHE_KEY = 'ii_clerk_pk';
  let _cachedPk = null;
  try { _cachedPk = localStorage.getItem(_PK_CACHE_KEY); } catch (_) {}

  // Kicked off immediately (in parallel with everything else) so it's
  // usually already resolved by the time anything actually needs it —
  // whether that's the first-ever load (no cache yet) or a retry after
  // the cached key turned out to be stale.
  const _configPromise = (async () => {
    const r = await fetch((window.API_BASE || '') + '/api/config');
    if (!r.ok) throw new Error('/api/config returned ' + r.status);
    const { clerkPublishableKey, error } = await r.json();
    if (error) throw new Error('/api/config error: ' + error);
    if (!clerkPublishableKey) throw new Error('/api/config did not return a clerkPublishableKey');
    try { localStorage.setItem(_PK_CACHE_KEY, clerkPublishableKey); } catch (_) {}
    return clerkPublishableKey;
  })();

  async function _loadClerkScript() {
    if (window.Clerk) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load Clerk script from CDN'));
      document.head.appendChild(s);
    });
    if (!window.Clerk) throw new Error('window.Clerk is not defined — CDN script did not load');
  }

  // Fetch the publishable key BEFORE loading the Clerk CDN bundle — this specific
  // build (clerk.browser.js) reads the key from window.__clerk_publishable_key
  // (or a data-clerk-publishable-key script attribute) at load time and
  // self-constructs window.Clerk as a ready instance; it throws if the key
  // isn't already set when the script executes.
  async function _initClerk(useFreshKey) {
    const pk = useFreshKey ? await _configPromise : (_cachedPk || await _configPromise);
    window.__clerk_publishable_key = pk;
    await _loadClerkScript();
    await window.Clerk.load();
    return window.Clerk;
  }

  let clerk = null;
  try {
    try {
      clerk = await _initClerk(false);
    } catch (err) {
      // Most failures here are transient (a slow/blipped CDN response, a
      // cold /api/config call, an out-of-date cached key) — retrying once
      // against a guaranteed-fresh key is what stops a random refresh from
      // silently landing on the "signed out" fallback below.
      console.warn('[auth.js] Clerk init attempt 1 failed, retrying with a fresh key:', err);
      clerk = await _initClerk(true);
    }
  } catch (err) {
    console.error('[auth.js] Clerk initialization failed:', err);
  }

  if (!clerk) {
    if (_leaving) return;
    // Auth state is unknown — the badge shell rendered above already shows
    // the (grey, signed-out-looking) account icon, so there's nothing more
    // to reveal here.
    window._auth = {
      user: null, clerk: null,
      getToken: _noopToken,
      signUp: _noop, confirmSignUp: _noop, signIn: _noop, signOut: _noop,
      requestPasswordReset: _noop, confirmPasswordReset: _noop,
      prepareSignInSecondFactor: _noop, attemptSignInSecondFactor: _noop,
      onReady: _noopReady,
    };
    _fireReady();
    return;
  }

  function _normalizeUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      username: u.username || '',
      email: u.primaryEmailAddress?.emailAddress || '',
      phone: u.primaryPhoneNumber?.phoneNumber || '',
      name: u.unsafeMetadata?.fullName || u.firstName || u.username || '',
      imageUrl: u.hasImage ? (u.imageUrl || '') : '',
    };
  }

  // Which contact channel a pending sign-up is waiting on ('email' or 'phone'),
  // so confirmSignUp() knows which Clerk verification call to make.
  let _pendingSignUpChannel = null;

  async function signUp({ username, password, email, phone }) {
    const payload = { username, password };
    if (email) payload.emailAddress = email;
    else if (phone) payload.phoneNumber = phone;
    const su = await clerk.client.signUp.create(payload);
    if (email) {
      await su.prepareEmailAddressVerification({ strategy: 'email_code' });
      _pendingSignUpChannel = 'email';
    } else {
      await su.preparePhoneNumberVerification({ strategy: 'phone_code' });
      _pendingSignUpChannel = 'phone';
    }
    return su;
  }

  async function confirmSignUp(code) {
    const su = clerk.client.signUp;
    const result = _pendingSignUpChannel === 'phone'
      ? await su.attemptPhoneNumberVerification({ code })
      : await su.attemptEmailAddressVerification({ code });
    if (result.status === 'complete') {
      await clerk.setActive({ session: result.createdSessionId });
    }
    return result;
  }

  async function signIn(identifier, password) {
    const si = await clerk.client.signIn.create({ identifier, password });
    if (si.status === 'complete') {
      await clerk.setActive({ session: si.createdSessionId });
    }
    return si;
  }

  async function prepareSignInSecondFactor(strategy) {
    return clerk.client.signIn.prepareSecondFactor({ strategy });
  }

  async function attemptSignInSecondFactor(strategy, code) {
    const si = clerk.client.signIn;
    const result = await si.attemptSecondFactor({ strategy, code });
    if (result.status === 'complete') {
      await clerk.setActive({ session: result.createdSessionId });
    }
    return result;
  }

  async function signOut() {
    if (!clerk) return; // clicked during the brief optimistic-badge window, before Clerk finished loading
    await clerk.signOut();
  }

  async function requestPasswordReset(email) {
    return clerk.client.signIn.create({ identifier: email, strategy: 'reset_password_email_code' });
  }

  async function confirmPasswordReset(code, newPassword) {
    const si = clerk.client.signIn;
    const result = await si.attemptFirstFactor({ strategy: 'reset_password_email_code', code, password: newPassword });
    if (result.status === 'complete') {
      await clerk.setActive({ session: result.createdSessionId });
    }
    return result;
  }

  async function getToken() {
    return clerk.session ? await clerk.session.getToken() : null;
  }

  function onReady(fn) {
    if (_ready) { fn(_currentUser); return; }
    _readyCallbacks.push(fn);
  }

  function _updateUI(user) {
    _currentUser = user;
    if (window._auth) window._auth.user = user;
    try { localStorage.setItem(_SIGNED_IN_CACHE_KEY, user ? '1' : '0'); } catch (_) {}
    const photoUrl = (user && user.imageUrl) || '';
    try { localStorage.setItem(_AVATAR_CACHE_KEY, photoUrl); } catch (_) {}
    const btn = document.getElementById('ib-account-btn');
    if (btn) {
      btn.classList.toggle('signed-in', !!user);
      btn.classList.toggle('has-photo', !!photoUrl);
      btn.innerHTML = _accountBtnIconHTML(photoUrl);
    }
    _renderAccountDropdown(!!user);
  }

  // Initialize — wrapped so that a failure here (e.g. an unexpected Clerk
  // user-object shape) can't silently strand every page in its pre-auth
  // "hidden" state or leave the account icon in limbo; onReady always fires.
  try {
    _currentUser = _normalizeUser(clerk.user);
    window._auth = {
      user: _currentUser, clerk,
      getToken,
      signUp, confirmSignUp, signIn, signOut,
      prepareSignInSecondFactor, attemptSignInSecondFactor,
      requestPasswordReset, confirmPasswordReset,
      onReady,
    };
    _updateUI(_currentUser);

    clerk.addListener(({ user }) => {
      if (_leaving) return;
      const normalized = _normalizeUser(user);
      try { _updateUI(normalized); }
      catch (err) { console.error('[auth.js] UI update on auth change failed:', err); }
      _changeCallbacks.forEach(fn => {
        try { fn(normalized); } catch (err) { console.error('[auth.js] onAuthChange callback failed:', err); }
      });
    });
  } catch (err) {
    console.error('[auth.js] initialization failed:', err);
    if (!window._auth) {
      window._auth = {
        user: null, clerk,
        getToken: _noopToken,
        signUp: _noop, confirmSignUp: _noop, signIn: _noop, signOut: _noop,
        requestPasswordReset: _noop, confirmPasswordReset: _noop,
        prepareSignInSecondFactor: _noop, attemptSignInSecondFactor: _noop,
        onReady: _noopReady,
      };
    }
  }

  _fireReady();
})();
