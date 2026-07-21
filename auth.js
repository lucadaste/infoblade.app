(async function () {
  let _readyCallbacks = [];
  let _ready = false;
  let _currentUser = null;

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
    _readyCallbacks.forEach(fn => fn(_currentUser));
    _readyCallbacks = [];
  }

  function _noop() { return Promise.resolve({ errors: [{ message: 'Auth unavailable' }] }); }
  async function _noopToken() { return null; }
  function _noopReady(fn) { fn(null); }

  // Load Clerk JS from CDN
  if (!window.Clerk) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  let clerk = null;
  try {
    const r = await fetch((window.API_BASE || '') + '/api/config');
    if (r.ok) {
      const { clerkPublishableKey } = await r.json();
      if (clerkPublishableKey) {
        clerk = new window.Clerk(clerkPublishableKey);
        await clerk.load();
      }
    }
  } catch (_) {}

  if (!clerk) {
    window._auth = {
      user: null, clerk: null,
      getToken: _noopToken,
      signUp: _noop, confirmSignUp: _noop, signIn: _noop, signOut: _noop,
      requestPasswordReset: _noop, confirmPasswordReset: _noop,
      onReady: _noopReady,
    };
    _fireReady();
    return;
  }

  function _normalizeUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      email: u.primaryEmailAddress?.emailAddress || '',
      name: u.unsafeMetadata?.fullName || u.firstName || '',
    };
  }

  async function signUp(name, email, password) {
    const su = await clerk.client.signUp.create({
      emailAddress: email,
      password,
      unsafeMetadata: { fullName: name },
    });
    await su.prepareEmailAddressVerification({ strategy: 'email_code' });
    return su;
  }

  async function confirmSignUp(code) {
    const su = clerk.client.signUp;
    const result = await su.attemptEmailAddressVerification({ code });
    if (result.status === 'complete') {
      await clerk.setActive({ session: result.createdSessionId });
    }
    return result;
  }

  async function signIn(email, password) {
    const si = await clerk.client.signIn.create({ identifier: email, password });
    if (si.status === 'complete') {
      await clerk.setActive({ session: si.createdSessionId });
    }
    return si;
  }

  async function signOut() {
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
    if (window._auth) window._auth.user = user;

    const badge   = document.getElementById('auth-badge');
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
  _currentUser = _normalizeUser(clerk.user);
  window._auth = {
    user: _currentUser, clerk,
    getToken,
    signUp, confirmSignUp, signIn, signOut,
    requestPasswordReset, confirmPasswordReset,
    onReady,
  };
  _updateUI(_currentUser);

  clerk.addListener(({ user }) => {
    _updateUI(_normalizeUser(user));
  });

  _fireReady();
})();
