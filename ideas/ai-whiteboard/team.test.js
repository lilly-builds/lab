/* node ideas/ai-whiteboard/team.test.js
   U7: invite creation, accept flow with scene preservation, friendly errors,
   member list labels (R17). Fake session + supabase client; no DOM. */
const assert = require('assert');
const team = require('./team.js');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
function mkServer() {
  return { inserted: [], acceptRows: [[]], memberRows: [], inviteError: null };
}
function fakeSb(server) {
  return {
    from: (table) => {
      if (table === 'invites') return {
        insert: (row) => { server.inserted.push(row); return { select: () => Promise.resolve(server.inviteError ? { data: null, error: server.inviteError } : { data: [{ token: 'tok-abc-1234567890' }], error: null }) }; },
        update: (row) => ({ eq: () => Promise.resolve({ data: [row], error: null }) })
      };
      if (table === 'board_member_profiles') return {
        select: () => ({ eq: () => ({ then: (res) => Promise.resolve({ data: server.memberRows, error: null }).then(res) }) })
      };
      throw new Error('unexpected table ' + table);
    },
    rpc: async (fn, args) => {
      server.acceptArgs = args;
      return { data: server.acceptRows[0], error: null };
    }
  };
}
function mkWin(search) {
  const w = {
    location: { search: search || '', origin: 'https://boards.example', pathname: '/app/', href: 'https://boards.example/app/' + (search || '') },
    history: { replaced: null, replaceState(a, b, u) { this.replaced = u; } }
  };
  return w;
}
const mkSession = (server) => ({ state: 'online', client: fakeSb(server), userId: 'u1', init: async () => {} });

const tests = [
  ['owner creates a single-use link with the chosen role (R8)', async () => {
    const server = mkServer(), storage = memStorage();
    storage.setItem('aiwb.board', 'b1');
    const tm = team.create({ session: mkSession(server), win: mkWin(''), storage });
    const r = await tm.createInvite('viewer');
    assert(r.ok);
    assert.strictEqual(r.url, 'https://boards.example/app/?invite=tok-abc-1234567890');
    assert.deepStrictEqual(server.inserted, [{ board_id: 'b1', role: 'viewer' }]);
    const r2 = await tm.createInvite('nonsense');
    assert.strictEqual(server.inserted[1].role, 'editor', 'unknown roles fall back to editor');
  }],
  ['a non-owner insert is reported, not thrown', async () => {
    const server = mkServer(); server.inviteError = { message: 'new row violates row-level security policy' };
    const storage = memStorage(); storage.setItem('aiwb.board', 'b1');
    const tm = team.create({ session: mkSession(server), win: mkWin(''), storage });
    const r = await tm.createInvite('editor');
    assert.strictEqual(r.error, 'not-owner');
  }],
  ['accept on a fresh device: board set, device scene stashed, token stripped (AE3)', async () => {
    const server = mkServer();
    server.acceptRows = [[{ board_id: 'b-shared', role: 'editor', error: null }]];
    const storage = memStorage();
    storage.setItem('aiwb.scene', JSON.stringify([{ id: 'e1', type: 'note' }]));
    const win = mkWin('?invite=tok-abc-1234567890');
    const tm = team.create({ session: mkSession(server), win, storage });
    const r = await tm.acceptPending();
    assert.deepStrictEqual({ handled: r.handled, ok: r.ok, boardId: r.boardId, role: r.role }, { handled: true, ok: true, boardId: 'b-shared', role: 'editor' });
    assert.deepStrictEqual(server.acceptArgs, { p_token: 'tok-abc-1234567890' });
    assert.strictEqual(storage.getItem('aiwb.board'), 'b-shared');
    assert.strictEqual(storage.getItem('aiwb.scene'), '[]');
    const stash = [...storage._m.keys()].find((k) => k.indexOf('aiwb.scene.prev.') === 0);
    assert(stash && storage.getItem(stash).includes('e1'), 'device scene stashed, nothing discarded');
    assert(win.history.replaced && win.history.replaced.indexOf('invite') === -1, 'token stripped from the URL');
  }],
  ['used, revoked or expired tokens get the friendly message; brute force is throttled', async () => {
    const server = mkServer();
    server.acceptRows = [[{ board_id: null, role: null, error: 'invalid_invite' }]];
    const tm = team.create({ session: mkSession(server), win: mkWin('?invite=dead-token-0000'), storage: memStorage() });
    const r = await tm.acceptPending();
    assert.strictEqual(r.error, 'invalid_invite');
    assert(/does not work anymore/.test(tm.ERRORS[r.error]));
    server.acceptRows = [[{ board_id: null, role: null, error: 'too_many_attempts' }]];
    const r2 = await team.create({ session: mkSession(server), win: mkWin('?invite=x'), storage: memStorage() }).acceptPending();
    assert(/give it an hour/.test(tm.ERRORS[r2.error]));
  }],
  ['already synced to another board: no swap under the person', async () => {
    const server = mkServer();
    server.acceptRows = [[{ board_id: 'b-other', role: 'editor', error: null }]];
    const storage = memStorage();
    storage.setItem('aiwb.board', 'b-mine');
    storage.setItem('aiwb.scene', JSON.stringify([{ id: 'e1', type: 'note' }]));
    const tm = team.create({ session: mkSession(server), win: mkWin('?invite=tok'), storage });
    const r = await tm.acceptPending();
    assert.strictEqual(r.error, 'already-synced');
    assert.strictEqual(storage.getItem('aiwb.board'), 'b-mine');
    assert(storage.getItem('aiwb.scene').includes('e1'), 'scene untouched');
  }],
  ['member list: names, collision disambiguators, guests, never emails (R17)', async () => {
    const server = mkServer();
    server.memberRows = [
      { id: 'u1', display_name: 'Lilly', claimed: true, role: 'owner' },
      { id: 'aaaa1111-0000', display_name: 'Sam', claimed: true, role: 'editor' },
      { id: 'bbbb2222-0000', display_name: 'Sam', claimed: true, role: 'viewer' },
      { id: 'cccc3333-0000', display_name: null, claimed: false, role: 'editor' }
    ];
    const storage = memStorage(); storage.setItem('aiwb.board', 'b1');
    const tm = team.create({ session: mkSession(server), win: mkWin(''), storage });
    const ms = await tm.members();
    assert.deepStrictEqual(ms.map((m) => m.name), ['Lilly', 'Sam ·aaaa', 'Sam ·bbbb', 'guest']);
    assert.strictEqual(ms[0].self, true);
    assert(ms.every((m) => !('email' in m) && m.name.indexOf('@') === -1), 'no emails anywhere');
    assert.strictEqual(tm.myRole(ms), 'owner');
  }]
];

(async () => {
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
