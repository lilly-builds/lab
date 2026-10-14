/* node ideas/ai-whiteboard/auth.test.js
   U5: claim validation + neutrality, same-user-id upgrade, R15 second-device
   choice with nothing discarded. Fake session + supabase client; no DOM. */
const assert = require('assert');
const auth = require('./auth.js');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
function mkServer() {
  return { updateCalls: [], otpCalls: [], rpcCalls: [], authCbs: [], boards: [], session: { user: { id: 'u1' } } };
}
function fakeSb(server) {
  return {
    auth: {
      updateUser: async ({ email }) => { server.updateCalls.push(email); if (server.updateThrows) throw new Error('obfuscated'); return { data: {}, error: null }; },
      signInWithOtp: async ({ email, options }) => { server.otpCalls.push({ email, redirect: options && options.emailRedirectTo }); return { data: {}, error: null }; },
      getSession: async () => ({ data: { session: server.session } }),
      onAuthStateChange: (cb) => { server.authCbs.push(cb); return { data: {} }; }
    },
    rpc: async (fn, args) => {
      server.rpcCalls.push({ fn, args, uid: server.session && server.session.user && server.session.user.id });
      if (fn === 'claim_email') { server.claimedName = args.p_display_name; return { data: null, error: null }; }
      return { data: null, error: null };
    },
    from: () => ({ select: () => ({ order: () => ({ then: (res) => Promise.resolve({ data: server.boards, error: null }).then(res) }) }) })
  };
}
function mkSession(server, state) {
  return {
    state: state || 'online', client: fakeSb(server), userId: 'u1', inits: 0, opened: [],
    init: async function () { this.inits++; },   /* a no-op after first start, like the real one */
    openBoard: async function (id) { this.opened.push(id); return true; }
  };
}

const tests = [
  ['claim requires a name and a plausible email, and never calls the backend otherwise', async () => {
    const server = mkServer(), storage = memStorage();
    const a = auth.create({ session: mkSession(server), win: {}, storage });
    assert.strictEqual((await a.claim('a@b.co', '')).error, 'name-required');
    assert.strictEqual((await a.claim('a@b.co', '  ')).error, 'name-required');
    assert.strictEqual((await a.claim('not-an-email', 'Lilly')).error, 'bad-email');
    assert.strictEqual((await a.claim('', 'Lilly')).error, 'bad-email');
    assert.strictEqual(server.updateCalls.length, 0, 'no backend call on invalid input');
  }],
  ['claim sends the magic link on the same anonymous user and stores the pending claim', async () => {
    const server = mkServer(), storage = memStorage();
    const a = auth.create({ session: mkSession(server), win: {}, storage });
    const r = await a.claim('  lilly@example.com ', ' Lilly ');
    assert.deepStrictEqual(r, { ok: true, status: 'check-email' });
    assert.deepStrictEqual(server.updateCalls, ['lilly@example.com'], 'trimmed email, same user (updateUser, not a new signup)');
    assert.deepStrictEqual(a.pendingClaim(), { email: 'lilly@example.com', name: 'Lilly' });
  }],
  ['already-registered email gets the identical neutral answer (nothing revealed)', async () => {
    const server = mkServer(); server.updateThrows = true; /* the obfuscated branch */
    const a = auth.create({ session: mkSession(server), win: {}, storage: memStorage() });
    const r = await a.claim('taken@example.com', 'Lilly');
    assert.deepStrictEqual(r, { ok: true, status: 'check-email' }, 'same neutral outcome');
  }],
  ['magic-link confirm claims the same user id; boards and juice stay attached', async () => {
    const server = mkServer(), storage = memStorage();
    const a = auth.create({ session: mkSession(server), win: {}, storage });
    await a.claim('lilly@example.com', 'Lilly');
    /* the link lands: the session now carries the email, user id unchanged */
    server.session = { user: { id: 'u1', email: 'lilly@example.com' } };
    const out = await a.onSession();
    assert.strictEqual(out.claimed, true);
    assert.strictEqual(server.claimedName, 'Lilly');
    assert(server.rpcCalls.every((c) => c.uid === 'u1'), 'every call ran as the same user id');
    assert.strictEqual(a.pendingClaim(), null, 'pending claim cleared');
    assert.strictEqual(out.choice, null, 'no local scene here, so no R15 choice');
  }],
  ['second device: sign-in link goes out with the current URL as redirect', async () => {
    const server = mkServer(), storage = memStorage();
    const a = auth.create({ session: mkSession(server), win: { location: { href: 'https://example.com/app/?x=1' } }, storage });
    const r = await a.signIn('lilly@example.com');
    assert.deepStrictEqual(r, { ok: true, status: 'check-email' });
    assert.deepStrictEqual(server.otpCalls, [{ email: 'lilly@example.com', redirect: 'https://example.com/app/?x=1' }]);
  }],
  ['R15: local scene + cloud board => the choice is offered; cloud stashes, local preserves (AE2)', async () => {
    const server = mkServer(), storage = memStorage();
    storage.setItem('aiwb.scene', JSON.stringify([{ id: 'e1', type: 'note' }, { id: 'e2', type: 'note' }]));
    server.session = { user: { id: 'u1', email: 'lilly@example.com' } };
    server.boards = [{ id: 'b1', created_at: '2026-10-01' }];
    const session = mkSession(server);
    const a = auth.create({ session, win: {}, storage });
    const out = await a.onSession();
    assert(out.choice, 'choice offered');
    assert.strictEqual(out.choice.localCount, 2);
    assert.strictEqual(out.choice.boards[0].id, 'b1');
    /* keep local: nothing changes, first save imports a second board */
    const keep = await a.resolveChoice('local');
    assert.strictEqual(keep.mode, 'local');
    assert.strictEqual(storage.getItem('aiwb.board'), null);
    assert(storage.getItem('aiwb.scene').includes('e1'), 'local scene untouched');
    /* open cloud: local stashed under the .prev. pattern, board id set, pull starts */
    storage.setItem('aiwb.scene', JSON.stringify([{ id: 'e1', type: 'note' }]));
    const open = await a.resolveChoice('cloud', 'b1');
    assert.strictEqual(open.mode, 'cloud');
    const stashKey = [...storage._m.keys()].find((k) => k.indexOf('aiwb.scene.prev.') === 0);
    assert(stashKey, 'local scene stashed, restorable');
    assert(storage.getItem(stashKey).includes('e1'));
    assert.deepStrictEqual(session.opened, ['b1'], 'the live session is rebound to the cloud board');
    assert.strictEqual(session.inits, 0, 'init() is not relied on (no-op after first start)');
    /* a failed open reports offline and leaves the device scene alone */
    session.openBoard = async () => false;
    const bad = await a.resolveChoice('cloud', 'b1');
    assert.strictEqual(bad.ok, false);
    assert(storage.getItem('aiwb.scene').includes('e1'), 'device scene intact after failed open');
  }],
  ['no cloud boards: no choice, the first save imports normally', async () => {
    const server = mkServer(), storage = memStorage();
    storage.setItem('aiwb.scene', JSON.stringify([{ id: 'e1', type: 'note' }]));
    server.session = { user: { id: 'u1', email: 'lilly@example.com' } };
    const a = auth.create({ session: mkSession(server), win: {}, storage });
    const out = await a.onSession();
    assert.strictEqual(out.claimed, true);
    assert.strictEqual(out.choice, null);
  }],
  ['backend down: claim and sign-in fail closed without touching storage', async () => {
    const server = mkServer();
    const session = { state: 'idle', client: null, init: async function () { this.state = 'offline'; } };
    const a = auth.create({ session, win: {}, storage: memStorage() });
    assert.strictEqual((await a.claim('a@b.co', 'Lilly')).error, 'offline');
    assert.strictEqual((await a.signIn('a@b.co')).error, 'offline');
  }]
];

(async () => {
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
