/* TEAM MODULE (U7): invite links, accept flow, member list.
   Plan: plans/2026-10-12-2015-feat-dreamspace-server-database-plan.md (R8, R9, R17).

   The owner creates a single-use link (?invite=<token>); invites are rows the
   owner inserts directly (policy-gated), the token is generated server-side.
   Opening a link runs accept_invite (server-throttled); success stashes the
   device scene under the app's .prev. backup pattern, points this browser at
   the shared board, and the sync session pulls it with the channel
   subscribed. Viewers are read-only by policy (AE7); a rejected write
   surfaces through the engine's existing dead-letter badge. The member list
   reads board_member_profiles - display name plus disambiguator, never an
   email (R17); unclaimed members show as "guest".

   Flag off: no AIWB_SYNC, no boot, no calls. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root && root.document) { root.AIWBTeam = api; api.boot(root); }
})(typeof self !== 'undefined' ? self : this, function () {
  var BOARD_KEY = 'aiwb.board';
  var SCENE_KEY = 'aiwb.scene';

  function boot(win) {
    function start() {
      if (!win.AIWB_SYNC || win.AIWB_TEAM) return;
      win.AIWB_TEAM = create({ session: win.AIWB_SYNC, win: win, storage: win.localStorage, ui: true });
    }
    if (win.document.readyState === 'complete') start();
    else win.addEventListener('load', start);
  }

  function lsGet(s, k) { try { return s.getItem(k); } catch (e) { return null; } }
  function lsSet(s, k, v) { try { s.setItem(k, v); } catch (e) {} }

  function pendingToken(win) {
    try { return new URLSearchParams((win.location && win.location.search) || '').get('invite'); }
    catch (e) { return null; }
  }
  function stripToken(win) {
    try {
      var u = new URL(win.location.href);
      u.searchParams.delete('invite');
      win.history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? '?' + u.searchParams : '') + u.hash);
    } catch (e) {}
  }

  var ERRORS = {
    invalid_invite: 'this link does not work anymore - ask for a fresh one',
    too_many_attempts: 'too many tries from here - give it an hour',
    offline: 'offline right now - try again in a moment'
  };

  function create(opts) {
    var session = opts.session, win = opts.win || {}, storage = opts.storage;
    var ui = null;

    function sb() { return session.client; }
    function boardId() { return lsGet(storage, BOARD_KEY); }

    /* ---- owner: create a single-use invite link (R8) ---- */
    async function createInvite(role) {
      role = role === 'viewer' ? 'viewer' : 'editor';
      var c = sb(); if (!c || !boardId()) return { ok: false, error: 'offline' };
      try {
        var r = await c.from('invites').insert({ board_id: boardId(), role: role }).select('token');
        var row = r.data && r.data[0];
        if (r.error || !row) return { ok: false, error: (r.error && /policy|permission/i.test(r.error.message || '')) ? 'not-owner' : 'failed' };
        var base = win.location ? win.location.origin + win.location.pathname : '';
        return { ok: true, url: base + '?invite=' + row.token, token: row.token };
      } catch (e) { return { ok: false, error: 'offline' }; }
    }

    async function revokeInvite(id) {
      var c = sb(); if (!c) return { ok: false, error: 'offline' };
      try {
        var r = await c.from('invites').update({ revoked_at: new Date().toISOString() }).eq('id', id);
        return r.error ? { ok: false, error: 'failed' } : { ok: true };
      } catch (e) { return { ok: false, error: 'offline' }; }
    }

    /* ---- invitee: accept the link before the first sync imports (R8) ---- */
    async function acceptPending() {
      var token = pendingToken(win);
      if (!token) return { handled: false };
      stripToken(win);
      var c = sb(); if (!c) return { handled: true, ok: false, error: 'offline' };
      var row = null;
      try {
        var r = await c.rpc('accept_invite', { p_token: token });
        row = r.data && r.data[0];
      } catch (e) { return { handled: true, ok: false, error: 'offline' }; }
      if (!row || !row.board_id) {
        var err = (row && row.error) || 'invalid_invite';
        if (ui) ui.render({ acceptError: ERRORS[err] || ERRORS.invalid_invite });
        return { handled: true, ok: false, error: err };
      }
      if (boardId() && boardId() !== row.board_id) {
        /* already synced to another board here: do not swap under the person */
        if (ui) ui.render({ acceptError: 'this browser is already synced to another board' });
        return { handled: true, ok: false, error: 'already-synced' };
      }
      var raw = lsGet(storage, SCENE_KEY);
      if (raw && raw !== '[]') lsSet(storage, SCENE_KEY + '.prev.' + Date.now(), raw); /* nothing discarded */
      lsSet(storage, SCENE_KEY, '[]');
      lsSet(storage, BOARD_KEY, row.board_id);
      return { handled: true, ok: true, boardId: row.board_id, role: row.role };
    }

    /* ---- member list: display names + disambiguators, never emails (R17) ---- */
    async function members() {
      var c = sb(); if (!c || !boardId()) return [];
      try {
        var r = await c.from('board_member_profiles').select('id,display_name,claimed,role').eq('board_id', boardId());
        return label((r && r.data) || [], session.userId);
      } catch (e) { return []; }
    }

    /* names may collide; the disambiguator is the id prefix, only shown then */
    function label(rows, selfId) {
      var counts = {};
      rows.forEach(function (m) {
        var name = m.claimed && m.display_name ? m.display_name : 'guest';
        m._name = name; counts[name] = (counts[name] || 0) + 1;
      });
      return rows.map(function (m) {
        return {
          id: m.id, role: m.role, self: m.id === selfId,
          name: counts[m._name] > 1 ? m._name + ' ·' + String(m.id).slice(0, 4) : m._name
        };
      });
    }

    function myRole(memberList) {
      var me = (memberList || []).filter(function (m) { return m.self; })[0];
      return me ? me.role : null;
    }

    if (opts.ui && win.document) ui = buildUi(win, { createInvite: createInvite, members: members, myRole: myRole });

    /* an invite link in the URL must win before any first-sync import */
    if (pendingToken(win)) {
      if (session.setBeforeImport) session.setBeforeImport(acceptPending);
      session.init();
    }

    return {
      createInvite: createInvite, revokeInvite: revokeInvite,
      acceptPending: acceptPending, members: members, label: label, myRole: myRole,
      ERRORS: ERRORS
    };
  }

  /* Minimal self-drawn UI: one button, one dialog with members + invite link. */
  function buildUi(win, api) {
    var doc = win.document, root, panel;
    var st = doc.createElement('style');
    st.textContent = '#aiwbTeamBtn{position:fixed;left:calc(12px + env(safe-area-inset-left));bottom:calc(var(--dockH,72px) + 36px);z-index:9;font:12px/1 "Special Elite","Courier New",monospace;background:#fff;border:1.6px solid #1e1e1e;border-radius:3px;padding:6px 10px;cursor:pointer;color:#1e1e1e}' +
      '#aiwbTeam{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.7)}' +
      '#aiwbTeam .card{background:#fff;border:1.6px solid #1e1e1e;border-radius:4px;padding:18px;width:min(340px,86vw);font:14px/1.6 "Special Elite","Courier New",monospace;color:#1e1e1e}' +
      '#aiwbTeam button{font:inherit;background:#fff;border:1.6px solid #1e1e1e;border-radius:3px;padding:6px 10px;cursor:pointer;margin:4px 4px 0 0}' +
      '#aiwbTeam .link{display:block;word-break:break-all;font-size:12px;border:1px dashed #1e1e1e;padding:6px;margin-top:8px}' +
      '#aiwbTeam .quiet{opacity:.65;font-size:12px;margin-top:8px}';
    doc.head.appendChild(st);
    var btn = doc.createElement('button');
    btn.id = 'aiwbTeamBtn'; btn.type = 'button'; btn.textContent = 'dream team';
    btn.addEventListener('click', open);
    doc.body.appendChild(btn);

    async function open() {
      close();
      root = doc.createElement('div'); root.id = 'aiwbTeam';
      panel = doc.createElement('div'); panel.className = 'card';
      panel.textContent = 'one moment...';
      root.appendChild(panel); doc.body.appendChild(root);
      var ms = await api.members();
      var mine = api.myRole(ms);
      var h = '<div>on this board</div>';
      h += ms.length ? ms.map(function (m) {
        return '<div>' + esc(m.name) + (m.self ? ' (you)' : '') + ' <span class="quiet">' + esc(m.role) + '</span></div>';
      }).join('') : '<div class="quiet">just you so far</div>';
      if (mine === 'owner') {
        h += '<div style="margin-top:10px"><button type="button" data-a="editor">invite an editor</button>' +
             '<button type="button" data-a="viewer">invite a viewer</button></div><div class="spot"></div>';
      }
      h += '<div class="quiet"><a href="#" data-a="close">close</a></div>';
      panel.innerHTML = h;
      panel.addEventListener('click', async function (e) {
        var a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
        if (!a) return;
        e.preventDefault();
        if (a === 'close') { close(); return; }
        var r = await api.createInvite(a);
        var spot = panel.querySelector('.spot');
        if (spot) spot.innerHTML = r.ok
          ? '<span class="link">' + esc(r.url) + '</span><span class="quiet">single use - send it to one person</span>'
          : '<span class="quiet">could not make a link (' + esc(r.error || 'failed') + ')</span>';
      });
    }
    function close() { if (root) { root.remove(); root = null; } }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    return {
      render: function (state) {
        if (state && state.acceptError) {
          close();
          root = doc.createElement('div'); root.id = 'aiwbTeam';
          panel = doc.createElement('div'); panel.className = 'card';
          panel.innerHTML = '<div>' + esc(state.acceptError) + '</div><div class="quiet"><a href="#" data-a="close">ok</a></div>';
          panel.addEventListener('click', function (e) { if (e.target.getAttribute('data-a') === 'close') close(); });
          root.appendChild(panel); doc.body.appendChild(root);
        }
      }
    };
  }

  return { boot: boot, create: create, pendingToken: pendingToken };
});
