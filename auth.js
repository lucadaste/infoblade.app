/**
 * auth.js — Supabase auth module loaded by all pages.
 * Exposes window._auth = { user, token, sb, signUp, signIn, signOut, onReady }
 */
(async function () {
  // Load Supabase JS from CDN
  if (!window.supabase) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // Fetch config from our API
  let sb = null;
  try {
    const r = await fetch((window.API_BASE || '') + '/api/config');
    if (r.ok) {
      const { url, anonKey } = await r.json();
      sb = window.supabase.createClient(url, anonKey);
    }
  } catch (_) {}

  if (!sb) {
    window._auth = { user: null, token: null, sb: null, signUp: _noop, signIn: _noop, signOut: _noop, onReady: _noopReady };
    _fireReady();
    return;
  }

  let _readyCallbacks = [];
  let _ready = false;
  let _currentUser = null;
  let _currentToken = null;

  function _noop() { return Promise.resolve({ error: { message: 'Auth unavailable' } }); }
  function _noopReady(fn) { fn(null, null); }

  async function signUp(email, password) {
    const { data, error } = await sb.auth.signUp({ email, password });
    return { data, error };
  }

  async function signIn(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    return { data, error };
  }

  async function signOut() {
    await sb.auth.signOut();
  }

  function onReady(fn) {
    if (_ready) { fn(_currentUser, _currentToken); return; }
    _readyCallbacks.push(fn);
  }

  function _fireReady() {
    _ready = true;
    _readyCallbacks.forEach(fn => fn(_currentUser, _currentToken));
    _readyCallbacks = [];
  }

  function _updateUI(user, token) {
    _currentUser = user;
    _currentToken = token;
    window._auth.user = user;
    window._auth.token = token;

    // Update auth badge if present on this page
    const badge = document.getElementById('auth-badge');
    const signinLink = document.getElementById('auth-signin-nav');
    if (!badge) return;

    if (user) {
      const email = user.email || '';
      const initials = email.slice(0, 2).toUpperCase();
      badge.innerHTML = `<span class="auth-avatar" title="${email}">${initials}</span><button class="auth-signout-btn" id="auth-signout">Sign out</button>`;
      badge.style.display = 'flex';
      if (signinLink) signinLink.style.display = 'none';
      document.getElementById('auth-signout')?.addEventListener('click', signOut);
    } else {
      badge.innerHTML = '';
      badge.style.display = 'none';
      if (signinLink) signinLink.style.display = '';
    }
  }

  // Initialize session
  const { data: { session } } = await sb.auth.getSession();
  _updateUI(session?.user ?? null, session?.access_token ?? null);

  // Listen for changes
  sb.auth.onAuthStateChange((_event, session) => {
    _updateUI(session?.user ?? null, session?.access_token ?? null);
  });

  window._auth = { get user() { return _currentUser; }, get token() { return _currentToken; }, sb, signUp, signIn, signOut, onReady };
  _fireReady();
})();
