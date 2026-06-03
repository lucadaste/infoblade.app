(async function () {
  let _readyCallbacks = [];
  let _ready = false;
  let _currentUser = null;
  let _currentToken = null;

  // Inject styles for auth badge dropdown
  const _styleEl = document.createElement('style');
  _styleEl.textContent = `
    #auth-badge { display: none; align-items: center; }
    .auth-avatar-wrap { position: relative; }
    .auth-avatar {
      width: 30px; height: 30px; border-radius: 50%;
      background: var(--accent, #00e676); color: #111;
      font-size: 12px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; user-select: none; flex-shrink: 0;
    }
    .auth-dropdown {
      display: none; position: absolute; top: calc(100% + 8px); right: 0;
      background: #1c1c1c; border: 1px solid #2a2a2a; border-radius: 8px;
      min-width: 120px; box-shadow: 0 8px 24px rgba(0,0,0,0.55); z-index: 600; overflow: hidden;
    }
    .auth-dropdown.open { display: block; }
    .auth-dropdown-item {
      display: block; width: 100%; padding: 11px 16px;
      background: none; border: none; color: #e8e6e0;
      font-family: 'DM Sans', sans-serif; font-size: 13px;
      text-align: left; cursor: pointer; transition: background 0.15s;
    }
    .auth-dropdown-item:hover { background: #252525; }
  `;
  document.head.appendChild(_styleEl);

  function _fireReady() {
    _ready = true;
    _readyCallbacks.forEach(fn => fn(_currentUser, _currentToken));
    _readyCallbacks = [];
  }

  function _noop() { return Promise.resolve({ error: { message: 'Auth unavailable' } }); }
  function _noopReady(fn) { fn(null, null); }

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

  async function signUp(email, password) {
    return sb.auth.signUp({ email, password });
  }

  async function signIn(email, password) {
    return sb.auth.signInWithPassword({ email, password });
  }

  async function signOut() {
    await sb.auth.signOut();
  }

  function onReady(fn) {
    if (_ready) { fn(_currentUser, _currentToken); return; }
    _readyCallbacks.push(fn);
  }

  let _dropdownCloseHandler = null;

  function _updateUI(user, token) {
    _currentUser = user;
    _currentToken = token;
    if (window._auth) { window._auth.user = user; window._auth.token = token; }

    const badge   = document.getElementById('auth-badge');
    const chatBtn = document.querySelector('.nav-chat-btn');
    const ctaBtn  = document.getElementById('signup-btn');

    if (user) {
      // Show avatar badge with dropdown
      if (badge) {
        const initials = (user.email || '').slice(0, 2).toUpperCase();
        badge.innerHTML = `
          <div class="auth-avatar-wrap">
            <span class="auth-avatar" id="auth-avatar" title="${user.email}">${initials}</span>
            <div class="auth-dropdown" id="auth-dropdown">
              <button class="auth-dropdown-item" id="auth-signout-btn">Sign out</button>
            </div>
          </div>`;
        badge.style.display = 'flex';

        // Remove old global listener if present
        if (_dropdownCloseHandler) document.removeEventListener('click', _dropdownCloseHandler);

        document.getElementById('auth-avatar').addEventListener('click', e => {
          e.stopPropagation();
          document.getElementById('auth-dropdown').classList.toggle('open');
        });
        _dropdownCloseHandler = () => document.getElementById('auth-dropdown')?.classList.remove('open');
        document.addEventListener('click', _dropdownCloseHandler);
        document.getElementById('auth-signout-btn').addEventListener('click', signOut);
      }

      if (ctaBtn)  ctaBtn.style.display = 'none';

    } else {
      // Logged out
      if (badge) { badge.innerHTML = ''; badge.style.display = 'none'; }
      if (ctaBtn)  ctaBtn.style.removeProperty('display');

      if (_dropdownCloseHandler) { document.removeEventListener('click', _dropdownCloseHandler); _dropdownCloseHandler = null; }
    }
  }

  // Initialize
  const { data: { session } } = await sb.auth.getSession();
  _currentUser  = session?.user  ?? null;
  _currentToken = session?.access_token ?? null;
  window._auth  = { user: _currentUser, token: _currentToken, sb, signUp, signIn, signOut, onReady };
  _updateUI(_currentUser, _currentToken);

  sb.auth.onAuthStateChange((_event, session) => {
    _updateUI(session?.user ?? null, session?.access_token ?? null);
    if (_event === 'PASSWORD_RECOVERY') {
      document.dispatchEvent(new CustomEvent('ii-password-recovery'));
    }
  });

  _fireReady();
})();
