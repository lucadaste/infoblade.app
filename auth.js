(async function () {
  let _readyCallbacks = [];
  let _ready = false;
  let _currentUser = null;

  // Exposed synchronously (function declarations are hoisted, so `onReady`
  // below is already callable here) so every page can register a callback
  // the instant this script tag finishes, instead of polling `window._auth`
  // with setTimeout(100) — that poll added up to 100ms of pure dead time to
  // every page load and login-triggered redirect for no reason.
  window._onAuthReady = onReady;

  // Inject styles for auth badge dropdown
  const _styleEl = document.createElement('style');
  _styleEl.textContent = `
    #auth-badge { display: flex; align-items: center; }
    .auth-avatar-wrap { position: relative; }
    .auth-avatar {
      width: 30px; height: 30px; border-radius: 50%;
      background: var(--muted); color: #111; border: none; padding: 0;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; user-select: none; flex-shrink: 0;
      transition: background 0.15s;
    }
    .auth-avatar:hover { background: var(--text-soft); }
    .auth-avatar.signed-in { background: var(--accent, #00e676); }
    .auth-avatar.signed-in:hover { background: var(--accent, #00e676); opacity: 0.85; }
    .auth-avatar svg { width: 16px; height: 16px; pointer-events: none; }
    .auth-dropdown {
      display: none; position: absolute; top: calc(100% + 8px); right: 0;
      background: var(--card); border: 1px solid var(--border); border-radius: 8px;
      min-width: 150px; box-shadow: 0 8px 24px rgba(0,0,0,0.55); z-index: 600; overflow: hidden;
    }
    .auth-dropdown.open { display: block; }
    .auth-dropdown-item {
      display: block; width: 100%; padding: 11px 16px;
      background: none; border: none; color: var(--ink);
      font-family: 'DM Sans', sans-serif; font-size: 13px;
      text-align: left; cursor: pointer; transition: background 0.15s;
    }
    .auth-dropdown-item:hover { background: var(--surface-2); }
    .auth-theme-item { display: flex; align-items: center; gap: 9px; border-top: 1px solid var(--border); }
    .auth-theme-item svg { width: 15px; height: 15px; flex-shrink: 0; color: var(--muted); }
  `;
  document.head.appendChild(_styleEl);

  // A generic person-in-a-circle icon. Rendered immediately (before Clerk even
  // starts loading) so the account icon is on screen at all times — grey while
  // signed out, green once we know the user is signed in — and never depends
  // on Clerk successfully initializing to simply be present.
  const _PERSON_ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="8" r="3.5" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 19c1.4-3.4 4.3-5.2 7.5-5.2s6.1 1.8 7.5 5.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const _SUN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>';
  const _MOON_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/></svg>';

  // Remembering the last known sign-in state lets the badge render in its
  // likely-correct color immediately on the next page load, instead of
  // always starting grey and visibly flipping to green once Clerk finishes
  // loading a few hundred ms later — that flip-delay is what read as "the
  // icon is slow." _updateUI() below keeps this in sync with reality.
  const _SIGNED_IN_CACHE_KEY = 'ii_was_signed_in';
  let _wasSignedIn = false;
  try { _wasSignedIn = localStorage.getItem(_SIGNED_IN_CACHE_KEY) === '1'; } catch (_) {}

  // Drives the click handler below — separate from _currentUser (the real,
  // confirmed auth state) because the badge can *look* signed-in optimistically
  // (from cache, above) before Clerk actually finishes confirming it. Gating
  // the click on _currentUser instead of this meant clicking the badge during
  // that window fell through to "open sign-in" even though it was showing
  // green — i.e. clicking your own account icon bounced you to sign in.
  let _visualSignedIn = _wasSignedIn;

  function _themeItemState() {
    const isLight = window.__iiTheme ? window.__iiTheme.get() === 'light' : false;
    return isLight ? { icon: _MOON_ICON, text: 'Dark mode' } : { icon: _SUN_ICON, text: 'Light mode' };
  }

  function _dropdownHTML() {
    const t = _themeItemState();
    return `
      <a class="auth-dropdown-item" href="/account.html" id="auth-account-btn">Your Account</a>
      <button class="auth-dropdown-item auth-theme-item" id="auth-theme-btn" type="button">${t.icon}<span id="auth-theme-label">${t.text}</span></button>
      <button class="auth-dropdown-item" id="auth-signout-btn">Sign out</button>
    `;
  }

  function _wireDropdownSignOut(dropdown) {
    const btn = dropdown.querySelector('#auth-signout-btn');
    if (btn) btn.addEventListener('click', () => signOut());
    const themeBtn = dropdown.querySelector('#auth-theme-btn');
    if (themeBtn) themeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.__iiTheme) window.__iiTheme.toggle();
      const t = _themeItemState();
      themeBtn.innerHTML = `${t.icon}<span id="auth-theme-label">${t.text}</span>`;
    });
  }

  function _renderBadgeShell() {
    const badge = document.getElementById('auth-badge');
    if (!badge) return;
    badge.innerHTML = `
      <div class="auth-avatar-wrap">
        <button class="auth-avatar${_wasSignedIn ? ' signed-in' : ''}" id="auth-avatar" type="button" aria-label="Account" title="${_wasSignedIn ? 'Your account' : 'Sign in'}">${_PERSON_ICON}</button>
        <div class="auth-dropdown" id="auth-dropdown">${_wasSignedIn ? _dropdownHTML() : ''}</div>
      </div>`;
    const dropdown = document.getElementById('auth-dropdown');
    if (_wasSignedIn) _wireDropdownSignOut(dropdown);
    document.getElementById('auth-avatar').addEventListener('click', function (e) {
      e.stopPropagation();
      if (_visualSignedIn) {
        dropdown.classList.toggle('open');
      } else if (typeof window.__iiOpenSignIn === 'function') {
        window.__iiOpenSignIn();
      } else {
        window.location.href = '/?modal=signin';
      }
    });
  }
  _renderBadgeShell();

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

  let _dropdownCloseHandler = null;

  function _updateUI(user) {
    _currentUser = user;
    _visualSignedIn = !!user;
    if (window._auth) window._auth.user = user;
    try { localStorage.setItem(_SIGNED_IN_CACHE_KEY, user ? '1' : '0'); } catch (_) {}

    const avatar   = document.getElementById('auth-avatar');
    const dropdown = document.getElementById('auth-dropdown');
    if (!avatar || !dropdown) return; // badge shell missing on this page

    if (_dropdownCloseHandler) { document.removeEventListener('click', _dropdownCloseHandler); _dropdownCloseHandler = null; }
    dropdown.classList.remove('open');

    if (user) {
      avatar.classList.add('signed-in');
      avatar.title = user.email || 'Your account';
      dropdown.innerHTML = _dropdownHTML();
      _wireDropdownSignOut(dropdown);
      _dropdownCloseHandler = () => dropdown.classList.remove('open');
      document.addEventListener('click', _dropdownCloseHandler);
    } else {
      avatar.classList.remove('signed-in');
      avatar.title = 'Sign in';
      dropdown.innerHTML = '';
    }
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
      try { _updateUI(_normalizeUser(user)); }
      catch (err) { console.error('[auth.js] UI update on auth change failed:', err); }
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
