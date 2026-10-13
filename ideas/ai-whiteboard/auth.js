/* AUTH MODULE (U5): email claim and second-device sign-in on top of the
   anonymous session. Plan: plans/2026-10-12-2015-feat-dreamspace-server-database-plan.md (R1, R3, R15, R17).

   The anonymous user id never changes: a claim attaches an email and display
   name to the same profile, so boards, memberships and juice follow
   automatically (R3). The already-registered response is deliberately
   obfuscated by Supabase; every path answers the same neutral "check your
   email" (never reveal which branch). Second device: a magic-link sign-in
   lands the claimed session; when both a local scene and a cloud board exist
   the person chooses (R15) - open the cloud board (local scene stashed under
   the app's own .prev. backup-key pattern, restorable) or keep the local
   scene as a second board. Nothing is silently discarded (AE2).

   Flag off: sync.js never creates a session, boot() finds no AIWB_SYNC and
   this file does nothing. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root && root.document) { root.AIWBAuth = api; api.boot(root); }
})(typeof self !== 'undefined' ? self : this, function () {
  var CLAIM_KEY = 'aiwb.claim';   /* pending claim {email, name} awaiting the magic-link confirm */
  var BOARD_KEY = 'aiwb.board';
  var SCENE_KEY = 'aiwb.scene';
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function boot(win) {
    function start() {
      if (!win.AIWB_SYNC || win.AIWB_AUTH) return;
      win.AIWB_AUTH = create({ session: win.AIWB_SYNC, win: win, storage: win.localStorage, ui: true });
    }
    if (win.document.readyState === 'complete') start();
    else win.addEventListener('load', start);
  }

  function lsGet(s, k) { try { return s.getItem(k); } catch (e) { return null; } }
  function lsSet(s, k, v) { try { s.setItem(k, v); } catch (e) {} }
  function lsDel(s, k) { try { s.removeItem(k); } catch (e) {} }

  function create(opts) {
    var session = opts.session, win = opts.win || {}, storage = opts.storage;
    var claimed = false, claimName = null, hooked = false;
    var ui = null;

    function sb() { return session.client; }
    function pending() { try { return JSON.parse(lsGet(storage, CLAIM_KEY) || 'null'); } catch (e) { return null; } }

    function hookEvents() {
      var c = sb();
      if (hooked || !c || !c.auth || !c.auth.onAuthStateChange) return;
      hooked = true;
      c.auth.onAuthStateChange(function () { onSession(); });
    }

    /* The claim and sign-in flows need a live client; claiming is itself the
       first sync-worthy action, so a fresh device initializes on intent. */
    async function ensureClient() {
      if (!sb()) await session.init();
      if (session.state !== 'online' || !sb()) return false;
      hookEvents();
      return true;
    }

    /* ---- claim: magic link on the existing anonymous user (R1) ---- */
    async function claim(email, name) {
      email = String(email || '').trim();
      name = String(name || '').trim();
      if (!name) return { ok: false, error: 'name-required' };
      if (!EMAIL_RE.test(email)) return { ok: false, error: 'bad-email' };
      if (!(await ensureClient())) return { ok: false, error: 'offline' };
      lsSet(storage, CLAIM_KEY, JSON.stringify({ email: email, name: name }));
      try { await sb().auth.updateUser({ email: email }); }
      catch (e) { /* stay neutral: the same message covers every branch */ }
      return { ok: true, status: 'check-email' };
    }

    /* ---- second device: magic-link sign-in as the claimed user ---- */
    async function signIn(email) {
      email = String(email || '').trim();
      if (!EMAIL_RE.test(email)) return { ok: false, error: 'bad-email' };
      if (!(await ensureClient())) return { ok: false, error: 'offline' };
      try {
        await sb().auth.signInWithOtp({
          email: email,
          options: { emailRedirectTo: win.location ? win.location.href : undefined }
        });
      } catch (e) { /* neutral */ }
      return { ok: true, status: 'check-email' };
    }

    /* The magic-link confirm landed: the session now carries an email. */
    async function onSession() {
      var c = sb(); if (!c) return { claimed: false, choice: null };
      var sess = null;
      try { sess = (await c.auth.getSession()).data.session; } catch (e) { return { claimed: false, choice: null }; }
      var email = sess && sess.user && sess.user.email;
      var p = pending();
      if (email && p) {
        try {
          var r = await c.rpc('claim_email', { p_display_name: p.name });
          if (!r.error) { claimed = true; claimName = p.name; lsDel(storage, CLAIM_KEY); }
        } catch (e) {}
      } else if (email) {
        claimed = true; /* claimed on another device; the profile row is already set */
      }
      var out = { claimed: claimed, name: claimName, choice: await r15Choice(sess) };
      if (ui) ui.render(out);
      return out;
    }

    /* R15: a claimed session in a browser holding a local scene but no synced
       board. Both sides have content: the person chooses (AE2). */
    async function r15Choice(sess) {
      var email = sess && sess.user && sess.user.email;
      if (!email || lsGet(storage, BOARD_KEY)) return null;
      var local = [];
      try { local = JSON.parse(lsGet(storage, SCENE_KEY) || '[]'); } catch (e) {}
      if (!local.length) return null;
      var boards = await cloudBoards();
      if (!boards.length) return null;
      return { boards: boards, localCount: local.length };
    }

    async function cloudBoards() {
      var c = sb(); if (!c) return [];
      try {
        var r = await c.from('boards').select('id,created_at').order('created_at', { ascending: false });
        return (r && r.data) || [];
      } catch (e) { return []; }
    }

    /* 'cloud': stash the local scene under the app's own .prev. backup-key
       pattern and open the cloud board. 'local': keep the device scene; the
       first save imports it as a second board. Never silently discard. */
    async function resolveChoice(which, boardId) {
      if (which !== 'cloud') return { ok: true, mode: 'local' };
      if (session.state === 'online' && lsGet(storage, BOARD_KEY) && lsGet(storage, BOARD_KEY) !== boardId) {
        return { ok: false, error: 'already-synced' }; /* a different board is live here; do not swap under the person */
      }
      var raw = lsGet(storage, SCENE_KEY);
      if (raw && raw !== '[]') lsSet(storage, SCENE_KEY + '.prev.' + Date.now(), raw);
      lsSet(storage, SCENE_KEY, '[]');
      lsSet(storage, BOARD_KEY, boardId);
      await session.init(); /* the returning-device path pulls the cloud board */
      if (ui) ui.render({ claimed: claimed, name: claimName, choice: null });
      return { ok: true, mode: 'cloud', boardId: boardId };
    }

    if (opts.ui && win.document) ui = buildUi(win, { claim: claim, signIn: signIn, resolveChoice: resolveChoice, onSession: onSession, session: session });
    if (sb()) hookEvents();

    return {
      get claimed() { return claimed; },
      get claimName() { return claimName; },
      claim: claim, signIn: signIn, onSession: onSession, resolveChoice: resolveChoice,
      pendingClaim: pending
    };
  }

  /* Minimal self-drawn UI (juice.js pattern): one button, one modal. Skipped
     in node tests. Everything routes through the api functions above. */
  function buildUi(win, api) {
    var doc = win.document, root, panel;
    var st = doc.createElement('style');
    st.textContent = '#aiwbAuthBtn{position:fixed;left:calc(12px + env(safe-area-inset-left));bottom:calc(var(--dockH,72px) + 8px);z-index:9;font:12px/1 "Special Elite","Courier New",monospace;background:#fff;border:1.6px solid #1e1e1e;border-radius:3px;padding:6px 10px;cursor:pointer;color:#1e1e1e}' +
      '#aiwbAuth{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.7)}' +
      '#aiwbAuth .card{background:#fff;border:1.6px solid #1e1e1e;border-radius:4px;padding:18px;width:min(320px,86vw);font:14px/1.5 "Special Elite","Courier New",monospace;color:#1e1e1e}' +
      '#aiwbAuth input{display:block;width:100%;box-sizing:border-box;margin:6px 0;padding:7px;font:inherit;border:1.2px solid #1e1e1e;border-radius:3px}' +
      '#aiwbAuth button{font:inherit;background:#fff;border:1.6px solid #1e1e1e;border-radius:3px;padding:7px 12px;cursor:pointer;margin-top:8px}' +
      '#aiwbAuth .quiet{opacity:.65;font-size:12px;margin-top:10px}' +
      '#aiwbAuth .err{color:#c00;font-size:12px;min-height:14px}';
    doc.head.appendChild(st);
    var btn = doc.createElement('button');
    btn.id = 'aiwbAuthBtn'; btn.type = 'button'; btn.textContent = 'keep my boards';
    btn.addEventListener('click', function () { open('form'); });
    doc.body.appendChild(btn);

    function open(mode) {
      close();
      root = doc.createElement('div'); root.id = 'aiwbAuth';
      panel = doc.createElement('div'); panel.className = 'card';
      root.appendChild(panel); doc.body.appendChild(root);
      renderMode(mode, {});
    }
    function close() { if (root) { root.remove(); root = null; } }

    function renderMode(mode, ctx) {
      if (!panel) return;
      if (mode === 'form') {
        panel.innerHTML = '<div>Keep these boards across devices</div>' +
          '<input id="aaName" placeholder="your name" autocomplete="name">' +
          '<input id="aaEmail" placeholder="you@email.com" autocomplete="email" inputmode="email">' +
          '<div class="err"></div><button type="button" data-a="claim">send my link</button>' +
          '<div class="quiet"><a href="#" data-a="signin">already claimed? sign in here</a> · <a href="#" data-a="close">not now</a></div>';
      } else if (mode === 'signin') {
        panel.innerHTML = '<div>Sign in with your email</div>' +
          '<input id="aaEmail" placeholder="you@email.com" autocomplete="email" inputmode="email">' +
          '<div class="err"></div><button type="button" data-a="signin-send">send my link</button>' +
          '<div class="quiet"><a href="#" data-a="close">not now</a></div>';
      } else if (mode === 'check-email') {
        panel.innerHTML = '<div>Check your email.</div><div class="quiet">Open the link on this device and your boards are here. ' +
          'If nothing arrives in a minute, check spam.</div><button type="button" data-a="close">done</button>';
      } else if (mode === 'choice') {
        panel.innerHTML = '<div>This device has its own board, and your account has one in the cloud.</div>' +
          '<button type="button" data-a="cloud">open the cloud board</button> ' +
          '<button type="button" data-a="local">keep this device\'s board</button>' +
          '<div class="quiet">Either way nothing is lost: the other scene stays saved on this device.</div>';
      }
      panel.addEventListener('click', onAction);
      function onAction(e) {
        var a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
        if (!a) return;
        e.preventDefault();
        var err = panel.querySelector('.err');
        if (a === 'close') close();
        else if (a === 'signin') renderMode('signin', {});
        else if (a === 'claim' || a === 'signin-send') {
          var email = panel.querySelector('#aaEmail').value;
          var name = panel.querySelector('#aaName') ? panel.querySelector('#aaName').value : '';
          var p = a === 'claim' ? api.claim(email, name) : api.signIn(email);
          Promise.resolve(p).then(function (r) {
            if (r && r.ok) { renderMode('check-email', {}); api.onSession(); }
            else if (err) err.textContent = r && r.error === 'bad-email' ? 'that email does not look right' : r && r.error === 'name-required' ? 'add your name so the board knows you' : 'offline right now - your board is safe here, try later';
          });
        } else if (a === 'cloud' || a === 'local') {
          var boards = (ctx && ctx.boards) || [];
          Promise.resolve(api.resolveChoice(a, boards[0] && boards[0].id)).then(function () { close(); });
        }
      }
    }

    /* public render: reflect claim state on the button, surface the R15 choice */
    function render(state) {
      btn.textContent = state && state.claimed && state.name ? state.name : state && state.claimed ? 'boards saved' : 'keep my boards';
      if (state && state.choice) open('choice'), (function () { renderMode('choice', state.choice); })();
    }
    return { render: render };
  }

  return { boot: boot, create: create, EMAIL_RE: EMAIL_RE };
});
