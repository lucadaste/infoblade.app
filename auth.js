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
    .ii-acct-overlay {
      display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75);
      z-index: 2100; align-items: center; justify-content: center;
    }
    .ii-acct-overlay.open { display: flex; }
    .ii-acct-card {
      background: #181818; border: 1px solid #2a2a2a; border-radius: 12px;
      padding: 32px; width: 100%; max-width: 380px; max-height: 85vh; overflow-y: auto;
      position: relative; font-family: 'DM Sans', sans-serif; color: #e8e6e0; box-sizing: border-box;
    }
    .ii-acct-close {
      position: absolute; top: 14px; right: 16px; background: none; border: none;
      color: #999; font-size: 22px; cursor: pointer; line-height: 1; transition: color 0.15s;
    }
    .ii-acct-close:hover { color: #fff; }
    .ii-acct-card h2 { font-family: 'Share Tech Mono', monospace; font-weight: 700; font-size: 20px; margin: 0 0 20px; }
    .ii-acct-card h3 {
      font-size: 12px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase;
      color: #999; margin: 24px 0 12px; border-top: 1px solid #2a2a2a; padding-top: 20px;
    }
    .ii-acct-card h3:first-of-type { border-top: none; padding-top: 0; margin-top: 0; }
    .ii-acct-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
    .ii-acct-field label { font-size: 11px; font-weight: 600; letter-spacing: 0.5px; color: #999; text-transform: uppercase; }
    .ii-acct-field input {
      background: #0a0a0a; border: 1px solid #2a2a2a; color: #e8e6e0;
      font-family: 'DM Sans', sans-serif; font-size: 14px; padding: 10px 12px;
      border-radius: 6px; outline: none; width: 100%; box-sizing: border-box;
    }
    .ii-acct-field input:focus { border-color: var(--accent, #00e676); }
    .ii-acct-btn {
      width: 100%; background: var(--accent, #00e676); color: #111;
      font-family: 'Share Tech Mono', monospace; font-weight: 700; font-size: 13px;
      padding: 10px; border: none; border-radius: 6px; cursor: pointer; margin-top: 4px;
      transition: opacity 0.15s;
    }
    .ii-acct-btn:hover { opacity: 0.85; }
    .ii-acct-btn:disabled { opacity: 0.5; cursor: default; }
    .ii-acct-btn-danger { background: #c84040; color: #fff; }
    .ii-acct-msg { font-size: 12px; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; display: none; }
    .ii-acct-msg.error { background: rgba(255,82,82,0.12); color: #ff7070; border: 1px solid rgba(255,82,82,0.2); display: block; }
    .ii-acct-msg.success { background: rgba(0,230,118,0.1); color: var(--accent, #00e676); border: 1px solid rgba(0,230,118,0.2); display: block; }
  `;
  document.head.appendChild(_styleEl);

  function _fireReady() {
    _ready = true;
    _readyCallbacks.forEach(fn => fn(_currentUser));
    _readyCallbacks = [];
  }

  function _noop() { return Promise.reject(new Error('Auth unavailable — please reload the page.')); }
  async function _noopToken() { return null; }
  function _noopReady(fn) { fn(null); }

  let clerk = null;
  try {
    // Fetch the publishable key BEFORE loading the Clerk CDN bundle — this specific
    // build (clerk.browser.js) reads the key from window.__clerk_publishable_key
    // (or a data-clerk-publishable-key script attribute) at load time and
    // self-constructs window.Clerk as a ready instance; it throws if the key
    // isn't already set when the script executes.
    const r = await fetch((window.API_BASE || '') + '/api/config');
    if (!r.ok) throw new Error('/api/config returned ' + r.status);
    const { clerkPublishableKey, error } = await r.json();
    if (error) throw new Error('/api/config error: ' + error);
    if (!clerkPublishableKey) throw new Error('/api/config did not return a clerkPublishableKey');

    window.__clerk_publishable_key = clerkPublishableKey;

    if (!window.Clerk) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load Clerk script from CDN'));
        document.head.appendChild(s);
      });
    }

    if (!window.Clerk) throw new Error('window.Clerk is not defined — CDN script did not load');
    clerk = window.Clerk;
    await clerk.load();
  } catch (err) {
    console.error('[auth.js] Clerk initialization failed:', err);
  }

  if (!clerk) {
    // Auth state is unknown — reveal the signup CTA rather than leaving it
    // hidden forever (it defaults to display:none in HTML to avoid a flash
    // for logged-in users while Clerk loads).
    document.getElementById('signup-btn')?.style.removeProperty('display');
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

  let _openAccountModal = null;

  function _initAccountModal() {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="ii-acct-overlay" id="ii-acct-overlay">
        <div class="ii-acct-card">
          <button class="ii-acct-close" id="ii-acct-close">&times;</button>
          <h2>Your Account</h2>
          <div id="ii-acct-msg" class="ii-acct-msg"></div>

          <h3>Name</h3>
          <div class="ii-acct-field"><input type="text" id="ii-acct-name" /></div>
          <button class="ii-acct-btn" id="ii-acct-save-name">Save Name</button>

          <h3>Email</h3>
          <div id="ii-acct-email-view">
            <div class="ii-acct-field"><input type="email" id="ii-acct-email" /></div>
            <button class="ii-acct-btn" id="ii-acct-save-email">Save Email</button>
          </div>
          <div id="ii-acct-email-verify" style="display:none">
            <div class="ii-acct-field"><label>Code</label><input type="text" id="ii-acct-email-code" inputmode="numeric" maxlength="6" /></div>
            <button class="ii-acct-btn" id="ii-acct-verify-email">Verify New Email</button>
          </div>

          <h3>Password</h3>
          <div class="ii-acct-field"><label>Current Password</label><input type="password" id="ii-acct-curpass" /></div>
          <div class="ii-acct-field"><label>New Password</label><input type="password" id="ii-acct-newpass" /></div>
          <button class="ii-acct-btn" id="ii-acct-save-pass">Change Password</button>

          <h3>Danger Zone</h3>
          <button class="ii-acct-btn ii-acct-btn-danger" id="ii-acct-delete">Delete Account</button>
        </div>
      </div>`;
    document.body.appendChild(wrap.firstElementChild);

    const overlay = document.getElementById('ii-acct-overlay');
    document.getElementById('ii-acct-close').addEventListener('click', () => overlay.classList.remove('open'));
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });

    function setMsg(text, type) {
      const el = document.getElementById('ii-acct-msg');
      el.textContent = text; el.className = 'ii-acct-msg ' + type;
    }
    function clearMsg() {
      const el = document.getElementById('ii-acct-msg');
      el.textContent = ''; el.className = 'ii-acct-msg';
    }

    document.getElementById('ii-acct-save-name').addEventListener('click', async function () {
      const name = document.getElementById('ii-acct-name').value.trim();
      if (!name) return setMsg('Name cannot be empty.', 'error');
      this.disabled = true;
      try {
        await clerk.user.update({ unsafeMetadata: { fullName: name } });
        _updateUI(_normalizeUser(clerk.user));
        setMsg('Name updated.', 'success');
      } catch (err) {
        setMsg(err?.errors?.[0]?.message || err?.message || 'Could not update name.', 'error');
      }
      this.disabled = false;
    });

    let _pendingEmail = null;
    document.getElementById('ii-acct-save-email').addEventListener('click', async function () {
      const email = document.getElementById('ii-acct-email').value.trim();
      if (!email) return setMsg('Please enter an email.', 'error');
      this.disabled = true;
      try {
        _pendingEmail = await clerk.user.createEmailAddress({ email });
        await _pendingEmail.prepareVerification({ strategy: 'email_code' });
        document.getElementById('ii-acct-email-view').style.display = 'none';
        document.getElementById('ii-acct-email-verify').style.display = '';
        clearMsg();
      } catch (err) {
        setMsg(err?.errors?.[0]?.message || err?.message || 'Could not update email.', 'error');
      }
      this.disabled = false;
    });

    document.getElementById('ii-acct-verify-email').addEventListener('click', async function () {
      const code = document.getElementById('ii-acct-email-code').value.trim();
      if (!code || !_pendingEmail) return setMsg('Please enter the code.', 'error');
      this.disabled = true;
      try {
        await _pendingEmail.attemptVerification({ code });
        const oldEmail = clerk.user.primaryEmailAddress;
        await clerk.user.update({ primaryEmailAddressId: _pendingEmail.id });
        if (oldEmail && oldEmail.id !== _pendingEmail.id) {
          try { await oldEmail.delete(); } catch (_) {}
        }
        _updateUI(_normalizeUser(clerk.user));
        document.getElementById('ii-acct-email-verify').style.display = 'none';
        document.getElementById('ii-acct-email-view').style.display = '';
        document.getElementById('ii-acct-email').value = clerk.user.primaryEmailAddress?.emailAddress || '';
        document.getElementById('ii-acct-email-code').value = '';
        _pendingEmail = null;
        setMsg('Email updated.', 'success');
      } catch (err) {
        setMsg(err?.errors?.[0]?.message || err?.message || 'Invalid or expired code.', 'error');
      }
      this.disabled = false;
    });

    document.getElementById('ii-acct-save-pass').addEventListener('click', async function () {
      const currentPassword = document.getElementById('ii-acct-curpass').value;
      const newPassword = document.getElementById('ii-acct-newpass').value;
      if (!currentPassword || !newPassword) return setMsg('Please fill in both password fields.', 'error');
      if (newPassword.length < 8) return setMsg('New password must be at least 8 characters.', 'error');
      this.disabled = true;
      try {
        await clerk.user.updatePassword({ currentPassword, newPassword });
        document.getElementById('ii-acct-curpass').value = '';
        document.getElementById('ii-acct-newpass').value = '';
        setMsg('Password updated.', 'success');
      } catch (err) {
        setMsg(err?.errors?.[0]?.message || err?.message || 'Could not update password.', 'error');
      }
      this.disabled = false;
    });

    document.getElementById('ii-acct-delete').addEventListener('click', async function () {
      if (!confirm('Are you sure you want to permanently delete your account? This cannot be undone.')) return;
      this.disabled = true;
      try {
        await clerk.user.delete();
        window.location.href = '/';
      } catch (err) {
        setMsg(err?.errors?.[0]?.message || err?.message || 'Could not delete account.', 'error');
        this.disabled = false;
      }
    });

    _openAccountModal = function () {
      document.getElementById('ii-acct-name').value = _currentUser?.name || '';
      document.getElementById('ii-acct-email').value = _currentUser?.email || '';
      document.getElementById('ii-acct-email-verify').style.display = 'none';
      document.getElementById('ii-acct-email-view').style.display = '';
      document.getElementById('ii-acct-curpass').value = '';
      document.getElementById('ii-acct-newpass').value = '';
      clearMsg();
      overlay.classList.add('open');
    };
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
        const initials = (user.name || user.email || '?').slice(0, 1).toUpperCase();
        badge.innerHTML = `
          <div class="auth-avatar-wrap">
            <span class="auth-avatar" id="auth-avatar" title="${user.email}">${initials}</span>
            <div class="auth-dropdown" id="auth-dropdown">
              <button class="auth-dropdown-item" id="auth-account-btn">Your Account</button>
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
        document.getElementById('auth-account-btn').addEventListener('click', () => {
          document.getElementById('auth-dropdown').classList.remove('open');
          if (_openAccountModal) _openAccountModal();
        });
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
  _initAccountModal();
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
