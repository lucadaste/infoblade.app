(async function () {
  let _readyCallbacks = [];
  let _ready = false;
  let _currentUser = null;

  // Inject styles for auth badge dropdown
  const _styleEl = document.createElement('style');
  _styleEl.textContent = `
    #auth-badge { display: flex; align-items: center; }
    .auth-avatar-wrap { position: relative; }
    .auth-avatar {
      width: 30px; height: 30px; border-radius: 50%;
      background: #555; color: #111; border: none; padding: 0;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; user-select: none; flex-shrink: 0;
      transition: background 0.15s;
    }
    .auth-avatar:hover { background: #666; }
    .auth-avatar.signed-in { background: var(--accent, #00e676); }
    .auth-avatar.signed-in:hover { background: var(--accent, #00e676); opacity: 0.85; }
    .auth-avatar svg { width: 16px; height: 16px; pointer-events: none; }
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

  // A generic person-in-a-circle icon. Rendered immediately (before Clerk even
  // starts loading) so the account icon is on screen at all times — grey while
  // signed out, green once we know the user is signed in — and never depends
  // on Clerk successfully initializing to simply be present.
  const _PERSON_ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="8" r="3.5" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 19c1.4-3.4 4.3-5.2 7.5-5.2s6.1 1.8 7.5 5.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  function _renderBadgeShell() {
    const badge = document.getElementById('auth-badge');
    if (!badge) return;
    badge.innerHTML = `
      <div class="auth-avatar-wrap">
        <button class="auth-avatar" id="auth-avatar" type="button" aria-label="Account" title="Sign in">${_PERSON_ICON}</button>
        <div class="auth-dropdown" id="auth-dropdown"></div>
      </div>`;
    document.getElementById('auth-avatar').addEventListener('click', function (e) {
      e.stopPropagation();
      if (_currentUser) {
        document.getElementById('auth-dropdown').classList.toggle('open');
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
      name: u.unsafeMetadata?.fullName || u.firstName || '',
    };
  }

  // Which contact channel a pending sign-up is waiting on ('email' or 'phone'),
  // so confirmSignUp() knows which Clerk verification call to make.
  let _pendingSignUpChannel = null;

  async function signUp({ username, password, email, phone }) {
    const payload = { username, password };
    if (email) payload.emailAddress = email;
    if (phone) payload.phoneNumber = phone;
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

          <div id="ii-acct-reverify" style="display:none">
            <h3 style="margin-top:0">Confirm It's You</h3>
            <div id="ii-acct-reverify-pass-view">
              <p style="font-size:12px;color:#999;margin-bottom:12px">For your security, please re-enter your password to continue.</p>
              <div class="ii-acct-field"><input type="password" id="ii-acct-reverify-pass" placeholder="Your password" /></div>
              <button class="ii-acct-btn" id="ii-acct-reverify-submit">Confirm</button>
            </div>
            <div id="ii-acct-reverify-code-view" style="display:none">
              <p style="font-size:12px;color:#999;margin-bottom:12px">Enter the code we emailed you to continue.</p>
              <div class="ii-acct-field"><input type="text" id="ii-acct-reverify-code" placeholder="123456" inputmode="numeric" maxlength="6" /></div>
              <button class="ii-acct-btn" id="ii-acct-reverify-code-submit">Verify</button>
            </div>
          </div>

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

          <h3>Phone Number</h3>
          <div id="ii-acct-phone-view">
            <div class="ii-acct-field"><input type="tel" id="ii-acct-phone" placeholder="e.g. +1 555 123 4567" /></div>
            <button class="ii-acct-btn" id="ii-acct-save-phone">Save Phone</button>
          </div>
          <div id="ii-acct-phone-verify" style="display:none">
            <div class="ii-acct-field"><label>Code</label><input type="text" id="ii-acct-phone-code" inputmode="numeric" maxlength="6" /></div>
            <button class="ii-acct-btn" id="ii-acct-verify-phone">Verify Phone</button>
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

    // Clerk requires "reverification" (re-proving identity within the last
    // ~10 min) before sensitive actions like changing a password or deleting
    // the account. When an action is blocked by this, prompt for the
    // password inline, verify the session, then let the caller retry once.
    function _isReverificationError(err) {
      const msg = err?.errors?.[0]?.message || err?.message || '';
      const code = err?.errors?.[0]?.code || '';
      return /reverif/i.test(msg) || /reverif/i.test(code);
    }

    let _reverifyResolve = null;
    let _reverifySecondFactorStrategy = null;
    const reverifyBox = document.getElementById('ii-acct-reverify');
    const reverifyPassView = document.getElementById('ii-acct-reverify-pass-view');
    const reverifyCodeView = document.getElementById('ii-acct-reverify-code-view');

    function _showReverifyPassStep() {
      reverifyCodeView.style.display = 'none';
      reverifyPassView.style.display = '';
      document.getElementById('ii-acct-reverify-pass').value = '';
      reverifyBox.style.display = '';
      document.querySelector('.ii-acct-card').scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(() => document.getElementById('ii-acct-reverify-pass').focus(), 50);
    }

    function _showReverifyCodeStep() {
      reverifyPassView.style.display = 'none';
      reverifyCodeView.style.display = '';
      document.getElementById('ii-acct-reverify-code').value = '';
      document.querySelector('.ii-acct-card').scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(() => document.getElementById('ii-acct-reverify-code').focus(), 50);
    }

    function _requestReverification() {
      return new Promise((resolve) => {
        _reverifyResolve = resolve;
        _showReverifyPassStep();
      });
    }

    // A verification attempt can resolve immediately, ask for a second
    // factor (e.g. email_code), or reject the factor just submitted.
    async function _advanceReverification(sv) {
      console.log('[reverify] status:', sv.status, sv);
      if (sv.status === 'complete') {
        reverifyBox.style.display = 'none';
        clearMsg();
        const resolve = _reverifyResolve; _reverifyResolve = null;
        if (resolve) resolve(true);
        return;
      }
      if (sv.status === 'needs_second_factor') {
        if (reverifyCodeView.style.display !== 'none') {
          // Already on the code step — this status means the code we just
          // submitted was wrong, not that we need to (re)send a new one.
          setMsg('Invalid code. Please try again.', 'error');
          return;
        }
        const factor = sv.supportedSecondFactors && sv.supportedSecondFactors[0];
        _reverifySecondFactorStrategy = (factor && factor.strategy) || 'email_code';
        try { await clerk.session.prepareSecondFactorVerification({ strategy: _reverifySecondFactorStrategy }); }
        catch (e) { console.warn('[reverify] prepareSecondFactorVerification failed:', e); }
        _showReverifyCodeStep();
        return;
      }
      // Wrong password/code, or an unhandled status — leave the prompt open
      // and _reverifyResolve intact so the user can retry instead of the
      // action silently failing.
      setMsg('Incorrect password. Please try again.', 'error');
    }

    document.getElementById('ii-acct-reverify-submit').addEventListener('click', async function () {
      const password = document.getElementById('ii-acct-reverify-pass').value;
      if (!password) return setMsg('Please enter your password.', 'error');
      this.disabled = true;
      try {
        let sv = await clerk.session.startVerification({ level: 'multi_factor' });
        if (sv.status !== 'complete') {
          sv = await clerk.session.attemptFirstFactorVerification({ strategy: 'password', password });
        }
        this.disabled = false;
        await _advanceReverification(sv);
      } catch (err) {
        this.disabled = false;
        setMsg(err?.errors?.[0]?.message || err?.message || 'Incorrect password.', 'error');
      }
    });

    document.getElementById('ii-acct-reverify-code-submit').addEventListener('click', async function () {
      const code = document.getElementById('ii-acct-reverify-code').value.trim();
      if (!code) return setMsg('Please enter the code.', 'error');
      this.disabled = true;
      try {
        const sv = await clerk.session.attemptSecondFactorVerification({ strategy: _reverifySecondFactorStrategy, code });
        this.disabled = false;
        await _advanceReverification(sv);
      } catch (err) {
        this.disabled = false;
        setMsg(err?.errors?.[0]?.message || err?.message || 'Invalid or expired code.', 'error');
      }
    });

    // Cancel a pending reverification if the user closes the modal instead
    // of completing it — otherwise the original action's promise hangs forever.
    document.getElementById('ii-acct-close').addEventListener('click', () => {
      if (_reverifyResolve) { const r = _reverifyResolve; _reverifyResolve = null; r(false); }
      reverifyBox.style.display = 'none';
    });

    // Runs fn(); if it fails specifically because reverification is needed,
    // prompts for the password inline and retries fn() once.
    async function _withReverification(fn) {
      try {
        return await fn();
      } catch (err) {
        if (!_isReverificationError(err)) throw err;
        const ok = await _requestReverification();
        if (!ok) throw err;
        return await fn();
      }
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
        _pendingEmail = await _withReverification(() => clerk.user.createEmailAddress({ email }));
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

    let _pendingPhone = null;
    document.getElementById('ii-acct-save-phone').addEventListener('click', async function () {
      const phone = document.getElementById('ii-acct-phone').value.trim();
      if (!phone) return setMsg('Please enter a phone number.', 'error');
      this.disabled = true;
      try {
        _pendingPhone = await _withReverification(() => clerk.user.createPhoneNumber({ phoneNumber: phone }));
        await _pendingPhone.prepareVerification({ strategy: 'phone_code' });
        document.getElementById('ii-acct-phone-view').style.display = 'none';
        document.getElementById('ii-acct-phone-verify').style.display = '';
        clearMsg();
      } catch (err) {
        setMsg(err?.errors?.[0]?.message || err?.message || 'Could not save phone number.', 'error');
      }
      this.disabled = false;
    });

    document.getElementById('ii-acct-verify-phone').addEventListener('click', async function () {
      const code = document.getElementById('ii-acct-phone-code').value.trim();
      if (!code || !_pendingPhone) return setMsg('Please enter the code.', 'error');
      this.disabled = true;
      try {
        await _pendingPhone.attemptVerification({ code });
        const oldPhone = clerk.user.primaryPhoneNumber;
        await clerk.user.update({ primaryPhoneNumberId: _pendingPhone.id });
        if (oldPhone && oldPhone.id !== _pendingPhone.id) {
          try { await oldPhone.delete(); } catch (_) {}
        }
        _updateUI(_normalizeUser(clerk.user));
        document.getElementById('ii-acct-phone-verify').style.display = 'none';
        document.getElementById('ii-acct-phone-view').style.display = '';
        document.getElementById('ii-acct-phone').value = clerk.user.primaryPhoneNumber?.phoneNumber || '';
        document.getElementById('ii-acct-phone-code').value = '';
        _pendingPhone = null;
        setMsg('Phone number updated.', 'success');
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
        await _withReverification(() => clerk.user.updatePassword({ currentPassword, newPassword }));
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
        await _withReverification(() => clerk.user.delete());
        window.location.href = '/';
      } catch (err) {
        setMsg(err?.errors?.[0]?.message || err?.message || 'Could not delete account.', 'error');
        this.disabled = false;
      }
    });

    _openAccountModal = function () {
      // Re-read straight from the live Clerk user instead of trusting the
      // cached _currentUser snapshot, and surface an error instead of
      // silently rendering blank fields if the two have drifted out of sync.
      const fresh = _normalizeUser(clerk.user);
      if (fresh) { _currentUser = fresh; if (window._auth) window._auth.user = fresh; }
      if (!fresh) {
        setMsg('Could not load your account info. Please close this and reload the page.', 'error');
      } else {
        clearMsg();
      }
      document.getElementById('ii-acct-name').value = fresh?.name || '';
      document.getElementById('ii-acct-email').value = fresh?.email || '';
      document.getElementById('ii-acct-phone').value = fresh?.phone || '';
      document.getElementById('ii-acct-email-verify').style.display = 'none';
      document.getElementById('ii-acct-email-view').style.display = '';
      document.getElementById('ii-acct-phone-verify').style.display = 'none';
      document.getElementById('ii-acct-phone-view').style.display = '';
      document.getElementById('ii-acct-curpass').value = '';
      document.getElementById('ii-acct-newpass').value = '';
      reverifyBox.style.display = 'none';
      overlay.classList.add('open');
    };
  }

  let _dropdownCloseHandler = null;

  function _updateUI(user) {
    _currentUser = user;
    if (window._auth) window._auth.user = user;

    const avatar   = document.getElementById('auth-avatar');
    const dropdown = document.getElementById('auth-dropdown');
    if (!avatar || !dropdown) return; // badge shell missing on this page

    if (_dropdownCloseHandler) { document.removeEventListener('click', _dropdownCloseHandler); _dropdownCloseHandler = null; }
    dropdown.classList.remove('open');

    if (user) {
      avatar.classList.add('signed-in');
      avatar.title = user.email || 'Your account';
      dropdown.innerHTML = `
        <button class="auth-dropdown-item" id="auth-account-btn">Your Account</button>
        <button class="auth-dropdown-item" id="auth-signout-btn">Sign out</button>
      `;
      _dropdownCloseHandler = () => dropdown.classList.remove('open');
      document.addEventListener('click', _dropdownCloseHandler);
      document.getElementById('auth-signout-btn').addEventListener('click', signOut);
      document.getElementById('auth-account-btn').addEventListener('click', () => {
        dropdown.classList.remove('open');
        if (_openAccountModal) _openAccountModal();
      });
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
    _initAccountModal();
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
