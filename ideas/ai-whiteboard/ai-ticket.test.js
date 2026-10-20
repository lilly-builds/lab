/* node ideas/ai-whiteboard/ai-ticket.test.js
   Invariant I5: a ticket allows two attempts at most, only for its person and ask hash. */
const assert = require('assert');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const m = await import('./supabase/functions/_shared/ticket.mjs');
  const secret = 'test-secret-not-real';
  const now = 1000000;
  const askHash = m.hashAsk('a bakery plan');
  const mk = () => m.issueTicket({ secret, person: 'p1', askHash, now });
  const check = (token, over) => m.verifyTicket(Object.assign({ secret, token, person: 'p1', askHash, now: now + 1000 }, over));

  const tests = [
    ['valid ticket verifies', () => assert.strictEqual(check(mk().token).ok, true)],
    ['hash ignores case and spacing', () => assert.strictEqual(m.hashAsk('  A  Bakery   PLAN '), askHash)],
    ['different ask, different hash', () => assert.notStrictEqual(m.hashAsk('other'), askHash)],
    ['tampered payload rejected', () => {
      const [body, sig] = mk().token.split('.');
      const p = JSON.parse(Buffer.from(body, 'base64url').toString());
      p.p = 'p2';
      const forged = Buffer.from(JSON.stringify(p)).toString('base64url') + '.' + sig;
      assert.strictEqual(check(forged, { person: 'p2' }).reason, 'bad_signature');
    }],
    ['signature from another secret rejected', () => {
      const other = m.issueTicket({ secret: 'different', person: 'p1', askHash, now }).token;
      assert.strictEqual(check(other).reason, 'bad_signature');
    }],
    ['garbage rejected', () => { assert.strictEqual(check('nope').reason, 'malformed'); assert.strictEqual(check(undefined).reason, 'malformed'); }],
    ['expired rejected', () => assert.strictEqual(check(mk().token, { now: now + m.DEFAULT_TTL_MS + 1 }).reason, 'expired')],
    ['a ticket outlives a full 5-minute build attempt plus the retry that follows it', () => {
      assert.ok(m.DEFAULT_TTL_MS >= 2 * 5 * 60 * 1000 + 60 * 1000, 'ttl ' + m.DEFAULT_TTL_MS);
      assert.strictEqual(check(mk().token, { now: now + 5 * 60 * 1000 + 30 * 1000 }).ok, true);
    }],
    ['wrong person rejected', () => assert.strictEqual(check(mk().token, { person: 'p2' }).reason, 'wrong_person')],
    ['wrong ask hash rejected', () => assert.strictEqual(check(mk().token, { askHash: m.hashAsk('x') }).reason, 'wrong_ask')],
    ['two attempts allowed, third refused', () => {
      let s = { attempts: 0, childIssued: false };
      let r = m.takeAttempt(s); assert.ok(r.ok); s = r.state;
      r = m.takeAttempt(s); assert.ok(r.ok); s = r.state;
      r = m.takeAttempt(s); assert.strictEqual(r.ok, false); assert.strictEqual(r.state.attempts, 2);
    }],
    ['a child ticket can be issued once', () => {
      let r = m.takeChild({ attempts: 1, childIssued: false }); assert.ok(r.ok);
      assert.strictEqual(m.takeChild(r.state).ok, false);
    }],
    ['child ticket carries its parent id', () => {
      const parent = mk();
      const child = m.issueTicket({ secret, person: 'p1', askHash, now, parent: parent.payload.id });
      assert.strictEqual(child.payload.par, parent.payload.id);
    }],
    ['missing secret throws', () => assert.throws(() => m.issueTicket({ secret: '', person: 'p', askHash, now })) ]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
