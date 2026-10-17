/* node ideas/ai-whiteboard/ai-admin.test.js
   Lilly's admin door against the OpenRouter mock and an in-memory ledger: a new tester gets a pass shown once and a capped key; grants
   raise the ledger and the key limit together; revoking disables the key; bad input never moves money. Real-database run: ai-db.test.js. */
const assert = require('assert');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const S = './supabase/functions/_shared/';
  const { admin, MAX_GRANT } = await import(S + 'admin.mjs');
  const keys = await import(S + 'keys.mjs');
  const { hashPass } = await import(S + 'auth.mjs');
  const { startMock } = await import(S + 'testing/mock-openrouter.mjs');

  async function world(over = {}) {
    const mock = await startMock();
    const cfg = { baseUrl: mock.url, masterKey: 'sk-master-SECRET' };
    const people = new Map(), ledger = [], flags = [];
    let seq = 0;
    const rpc = async (name, a) => {
      if (name === 'ledger_adjust') {
        if (ledger.some((r) => r.idem === a.p_idem)) return { data: null };
        ledger.push({ id: ++seq, person: a.p_person, reason: 'adjustment', amount: a.p_amount, idem: a.p_idem });
        return { data: null };
      }
      if (name === 'ledger_settle' || name === 'ledger_release') { ledger.push({ id: ++seq, call: name, ...a }); return { data: null }; }
      return { error: { message: 'unknown ' + name } };
    };
    const deps = {
      rpc,
      createPass: async (hash, label) => { const id = '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0'); people.set(id, { hash, label, disabled: false }); return id; },
      setKey: async (p, hash, enc) => { Object.assign(people.get(p), { keyHash: hash, keyEnc: enc }); },
      revokePass: async (p) => { const x = people.get(p); x.disabled = true; return x.keyHash || null; },
      setPaused: async (p, v) => { people.get(p).paused = v; },
      createKey: over.createKey || ((o) => keys.createKey(cfg, o)),
      disableKey: (h) => keys.disableKey(cfg, h),
      encrypt: (k) => keys.encryptKey(k, 'enc-secret'),
      flag: async (cause) => { flags.push(cause); return true; },
      openFlags: async () => flags.map((c, i) => ({ id: i + 1, cause: c })),
      resolveFlag: async () => {},
      limits: {
        loadRows: async (p) => ledger.filter((r) => r.person === p).map((r) => ({ id: r.id, reason: r.reason, amount: r.amount })),
        keyHashOf: async (p) => people.get(p).keyHash,
        setLimit: (h, l) => keys.setKeyLimit(cfg, h, l),
        enqueue: async () => {}
      }
    };
    return { mock, deps, people, ledger, flags };
  }

  const tests = [
    ['create: a pass shown once, stored only as its hash, a key capped at the grant and stored encrypted', async () => {
      const w = await world();
      try {
        const r = await admin(w.deps, { action: 'create', label: 'Sam', grant: 5 });
        assert.strictEqual(r.status, 200);
        const p = w.people.get(r.body.person);
        assert.strictEqual(p.hash, hashPass(r.body.pass));
        assert.ok(!JSON.stringify([...w.people.values()]).includes(r.body.pass), 'the pass itself is stored nowhere');
        const k = w.mock.state.keys.get(p.keyHash);
        assert.strictEqual(k.limit, 5);
        assert.ok(!p.keyEnc.includes('sk-mock'), 'the key is stored encrypted');
        assert.strictEqual(keys.decryptKey(p.keyEnc, 'enc-secret'), 'sk-mock-' + p.keyHash);
      } finally { await w.mock.close(); }
    }],
    ['create: the label never reaches OpenRouter', async () => {
      let sentName = null;
      const w = await world({ createKey: async (o) => { sentName = o.name; return { key: 'sk-x', hash: 'h1' }; } });
      try {
        await admin(w.deps, { action: 'create', label: 'Sam Jones', grant: 1 });
        assert.ok(sentName && !sentName.includes('Sam'));
      } finally { await w.mock.close(); }
    }],
    ['create: no key, no tester; the pass is revoked', async () => {
      const w = await world({ createKey: async () => { throw new Error('down'); } });
      try {
        const r = await admin(w.deps, { action: 'create', label: 'x', grant: 1 });
        assert.deepStrictEqual([r.status, r.body.reason], [502, 'key_failed']);
        assert.ok([...w.people.values()][0].disabled);
        assert.ok(!('pass' in r.body));
      } finally { await w.mock.close(); }
    }],
    ['create and grant refuse zero, negative, fractional-cent and over-cap amounts before moving money', async () => {
      const w = await world();
      try {
        for (const g of [0, -1, 0.001, MAX_GRANT + 1, '5', NaN]) assert.strictEqual((await admin(w.deps, { action: 'create', grant: g })).status, 400, String(g));
        for (const g of [0, -1, 0.001, MAX_GRANT + 1]) assert.strictEqual((await admin(w.deps, { action: 'grant', person: '00000000-0000-4000-8000-000000000001', amount: g, idem: 'k' })).status, 400);
        assert.strictEqual(w.ledger.length, 0);
      } finally { await w.mock.close(); }
    }],
    ['grant: raises the ledger and SETS the key limit to the new total; a retry with the same idem is one grant', async () => {
      const w = await world();
      try {
        const c = await admin(w.deps, { action: 'create', label: 'x', grant: 5 });
        const g1 = await admin(w.deps, { action: 'grant', person: c.body.person, amount: 3, idem: 'oct-17' });
        const g2 = await admin(w.deps, { action: 'grant', person: c.body.person, amount: 3, idem: 'oct-17' });
        assert.deepStrictEqual([g1.body.limit, g2.body.limit], [8, 8]);
        assert.strictEqual(w.mock.state.keys.get(w.people.get(c.body.person).keyHash).limit, 8);
        assert.strictEqual(w.ledger.filter((r) => r.person === c.body.person).length, 2);
      } finally { await w.mock.close(); }
    }],
    ['grant: needs an idem key so a retried request is never a second grant', async () => {
      const w = await world();
      try { assert.strictEqual((await admin(w.deps, { action: 'grant', person: '00000000-0000-4000-8000-000000000001', amount: 1 })).status, 400); }
      finally { await w.mock.close(); }
    }],
    ['revoke: the pass is disabled and the key is disabled at OpenRouter', async () => {
      const w = await world();
      try {
        const c = await admin(w.deps, { action: 'create', label: 'x', grant: 1 });
        const r = await admin(w.deps, { action: 'revoke', person: c.body.person });
        assert.strictEqual(r.body.keyDisabled, true);
        assert.strictEqual(w.mock.state.keys.get(w.people.get(c.body.person).keyHash).disabled, true);
      } finally { await w.mock.close(); }
    }],
    ['revoke: a key that cannot be disabled raises a high flag and says so', async () => {
      const w = await world();
      try {
        const c = await admin(w.deps, { action: 'create', label: 'x', grant: 1 });
        w.deps.disableKey = async () => { throw new Error('down'); };
        const r = await admin(w.deps, { action: 'revoke', person: c.body.person });
        assert.strictEqual(r.body.keyDisabled, false);
        assert.ok(w.flags.includes('revoke_key_failed:' + c.body.person));
      } finally { await w.mock.close(); }
    }],
    ['settle_hold: a human settles a flagged hold to a cost, or releases it at zero', async () => {
      const w = await world();
      try {
        await admin(w.deps, { action: 'settle_hold', request: 'run:t:1', cost: 0.04 });
        await admin(w.deps, { action: 'settle_hold', request: 'run:t:2', cost: 0 });
        assert.deepStrictEqual(w.ledger.map((r) => r.call), ['ledger_settle', 'ledger_release']);
        assert.strictEqual((await admin(w.deps, { action: 'settle_hold', request: 'x', cost: -1 })).status, 400);
      } finally { await w.mock.close(); }
    }],
    ['an unknown action or a malformed person id is refused', async () => {
      const w = await world();
      try {
        assert.strictEqual((await admin(w.deps, { action: 'drop_tables' })).body.reason, 'unknown_action');
        assert.strictEqual((await admin(w.deps, { action: 'revoke', person: "x' or 1=1" })).status, 400);
      } finally { await w.mock.close(); }
    }]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
