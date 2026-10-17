/* node ideas/ai-whiteboard/ai-outcome.test.js
   The real path on this machine: HTTP into the actual function handlers, a real Postgres (the migrations in supabase/migrations), and the
   OpenRouter mock over HTTP. Proves the money flow end to end (I1, I2, I3, I5), outcome logging (build plan 1.20), and I6: no tester
   pass, provisioned key or prompt text in any log line or table. Needs AI_TEST_DATABASE_URL (a scratch database from
   supabase/tests/scratch.sh); skips without it, so CI's client job does not run it. */
const assert = require('assert');

const DB = process.env.AI_TEST_DATABASE_URL;
if (!DB) { console.log('skip: set AI_TEST_DATABASE_URL to a scratch database prepared by supabase/tests/scratch.sh'); process.exit(0); }

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const { startDevServer } = await import('./tools/dev-server.mjs');
  const { psqlRows } = await import('./supabase/functions/_shared/testing/psql-rpc.mjs');

  // Every log line the handlers write, for the I6 check.
  const logs = [];
  const origErr = console.error;
  console.error = (...a) => { logs.push(a.join(' ')); };

  const s = await startDevServer({ dbUrl: DB, envOver: { AI_ORPHAN_WAIT_SECS: '0' } }); // cleanup may settle a hold at once
  // What the mock charged, in call order (I3 compares the ledger with these, to the millionth).
  const gens = () => [...s.mock.state.gens.values()];
  const sum = (xs) => xs.reduce((a, x) => a + Math.round(x * 1e6), 0) / 1e6;
  const fn = (name) => s.url + '/functions/v1/' + name;
  const post = (name, body, bearer, extra = {}) => fetch(fn(name), { method: 'POST', headers: { 'content-type': 'application/json', origin: s.url, ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...extra }, body: JSON.stringify(body) });
  async function runStream(body, bearer) {
    const res = await post('run', body, bearer);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    return { lines, done: lines[lines.length - 1], deltas: lines.filter((l) => l.t === 'delta').map((l) => l.d).join('') };
  }
  const BOARD = JSON.stringify({ view: { x: 0, y: 0, width: 1200, height: 800 }, free: [{ x: 100, y: 100, width: 900, height: 600 }], elements: [] });
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const ASK1 = 'open a tiny bakery that sells only croissants';
  const ASK2 = 'add two ideas about the menu';

  let tester, person, firstTicket;
  const balance = async () => Number((await psqlRows(DB, "select public.ai_balance('" + person + "', true) as b"))[0].b);
  const spendRows = async () => psqlRows(DB, "select request_id, amount from public.credit_ledger where person_id = '" + person + "' and reason = 'spend' order by id");

  const tests = [
    ['admin: a wrong secret is refused; the right one creates a tester with a $1 grant and a capped key', async () => {
      assert.strictEqual((await post('admin', { action: 'create', grant: 1 }, 'not-the-secret')).status, 401);
      const r = await (await post('admin', { action: 'create', label: 'e2e', grant: 1 }, s.env.AI_ADMIN_SECRET)).json();
      assert.ok(r.ok && r.pass && r.person, JSON.stringify(r));
      tester = r.pass; person = r.person;
      assert.strictEqual(await balance(), 1);
      assert.strictEqual([...s.mock.state.keys.values()].pop().limit, 1);
    }],
    ['CORS: the board\'s origin is allowed; any other origin gets no allow header', async () => {
      const ok = await fetch(fn('route'), { method: 'OPTIONS', headers: { origin: s.url } });
      assert.strictEqual(ok.headers.get('access-control-allow-origin'), s.url);
      const evil = await fetch(fn('route'), { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
      assert.strictEqual(evil.headers.get('access-control-allow-origin'), null);
    }],
    ['first ask ever: /route gives an idea-map ticket without a router call; /run streams the map and settles to real cost', async () => {
      const g0 = gens().length;
      const r = await (await post('route', { ask: ASK1, summary: { counts: {} }, hasImage: true }, tester)).json();
      assert.deepStrictEqual([r.ok, r.job, r.firstAsk], [true, 'ideamap', true]);
      assert.strictEqual(gens().length - g0, 1, 'route made one call: the gate (no router on a first ask)');
      firstTicket = r.ticket;
      const out = await runStream({ ticket: r.ticket, ask: ASK1, board: BOARD, image: PNG, advanceEm: 0.6 }, tester);
      assert.deepStrictEqual([out.done.t, out.done.status, out.done.ok, out.done.job], ['done', 200, true, 'ideamap']);
      assert.strictEqual(out.deltas, out.done.text, 'the streamed pieces add up to the answer');
      const reply = JSON.parse(out.done.text);
      assert.strictEqual(reply.add.filter((e) => e.type === 'note').length, 5);
      assert.strictEqual(reply.add.filter((e) => e.type === 'arrow').length, 4);
      // I3: the ledger records exactly what the plug reported: the route's gate call, then the run's gate and job calls.
      const charged = gens().slice(g0);
      assert.deepStrictEqual((await spendRows()).map((x) => Number(x.amount)), [sum(charged.slice(0, 1)), sum(charged.slice(1, 3))]);
      assert.strictEqual(await balance(), Math.round((1 - sum(charged)) * 1e6) / 1e6);
    }],
    ['the picture reached the job model and the gate as image parts', async () => {
      const calls = s.mock.state.calls.slice(-2);
      assert.ok(calls.every((c) => Array.isArray(c.messages[1].content) && c.messages[1].content[1].type === 'image_url'));
    }],
    ['second ask: the router runs and a normal draw comes back', async () => {
      const r = await (await post('route', { ask: ASK2, summary: { counts: { note: 5 } }, hasImage: true }, tester)).json();
      assert.deepStrictEqual([r.job, r.firstAsk], ['draw', false]);
      const out = await runStream({ ticket: r.ticket, ask: ASK2, board: BOARD, image: PNG, advanceEm: 0.6 }, tester);
      assert.strictEqual(out.done.ok, true);
      assert.ok(Array.isArray(JSON.parse(out.done.text).next), 'next moves ride along');
    }],
    ['a cut-off attempt keeps its hold until cleanup settles it at the real cost; attempt 2 uses the next model; attempt 3 is refused (I2, I3, I5)', async () => {
      const g0 = gens().length;
      const r = await (await post('route', { ask: 'a dream plan', job: 'plan' }, tester)).json();
      const tid = JSON.parse(Buffer.from(r.ticket.split('.')[0], 'base64url').toString()).id;
      s.mock.state.modeFilter = (b) => !/safety check/.test(b.messages[0].content); // cut the job call, not the gate
      s.mock.state.mode = 'cutoff';
      const a1 = await runStream({ ticket: r.ticket, ask: 'a dream plan' }, tester);
      s.mock.state.mode = 'ok'; s.mock.state.modeFilter = null;
      assert.deepStrictEqual([a1.done.status, a1.done.reason, a1.done.canRetry], [502, 'cut_off', true]);
      const held = await psqlRows(DB, "select state from public.ai_holds where request_id = 'run:" + tid + ":1'");
      assert.deepStrictEqual(held.map((h) => h.state), ['open'], 'the cut-off cost is not known yet, so the hold stays');
      const a2 = await runStream({ ticket: r.ticket, ask: 'a dream plan' }, tester);
      assert.deepStrictEqual([a2.done.status, a2.done.attempt], [200, 2]);
      const jobModels = s.mock.state.calls.slice(-4).filter((c) => !/safety check/.test(c.messages[0].content)).map((c) => c.models[0]);
      assert.strictEqual(new Set(jobModels).size, 2, 'attempt 2 led with a different model');
      const a3 = await runStream({ ticket: r.ticket, ask: 'a dream plan' }, tester);
      assert.deepStrictEqual([a3.done.status, a3.done.reason], [403, 'no_attempts_left']);

      const report = (await (await post('cleanup', {}, s.env.AI_CRON_SECRET)).json()).report;
      assert.strictEqual(report.settled, 1, 'cleanup settled the cut-off hold by looking up its generation');
      const c = gens().slice(g0); // route gate, attempt 1 gate + cut-off job, attempt 2 gate + job
      assert.strictEqual(c.length, 5);
      const spent = async (id) => Number((await psqlRows(DB, "select amount from public.credit_ledger where request_id = '" + id + "'"))[0].amount);
      assert.strictEqual(await spent('run:' + tid + ':1'), sum(c.slice(1, 3)), 'the cut-off attempt is charged its real cost');
      assert.strictEqual(await spent('run:' + tid + ':2'), sum(c.slice(3, 5)));
    }],
    ['no hold is left open after finished calls (I2)', async () => {
      const open = await psqlRows(DB, "select request_id from public.ai_holds where person_id = '" + person + "' and state = 'open'");
      assert.deepStrictEqual(open, []);
    }],
    ['outcome: an undo is logged as a code with its ticket, and a bad code or a forged ticket is refused', async () => {
      assert.strictEqual((await post('outcome', { ticket: firstTicket, code: 'undo' }, tester)).status, 200);
      assert.strictEqual((await post('outcome', { ticket: firstTicket, code: 'loved it' }, tester)).status, 400);
      assert.strictEqual((await post('outcome', { ticket: firstTicket.slice(0, -2) + 'xx', code: 'undo' }, tester)).status, 403);
      const rows = await psqlRows(DB, "select code from public.ai_outcomes where person_id = '" + person + "'");
      assert.deepStrictEqual(rows.map((x) => x.code), ['undo']);
    }],
    ['a bigger request body than the cap is refused before it is read in full', async () => {
      const res = await post('run', { ticket: 'x', ask: 'x', board: 'x'.repeat(2100000) }, tester);
      const body = await res.json();
      assert.deepStrictEqual([res.status, body.reason], [413, 'too_big']);
    }],
    ['cleanup over HTTP needs the cron secret and reports what it did', async () => {
      assert.strictEqual((await post('cleanup', {}, s.env.AI_ADMIN_SECRET)).status, 401);
      const r = await (await post('cleanup', {}, s.env.AI_CRON_SECRET)).json();
      assert.ok(r.ok && r.report && typeof r.report.settled === 'number');
    }],
    ['reconcile: the ledger and the key agree, so this tester raises no flag', async () => {
      const r = await (await post('reconcile', {}, s.env.AI_CRON_SECRET)).json();
      assert.ok(r.ok);
      const flags = await psqlRows(DB, "select cause from public.ops_flags where person_id = '" + person + "' and resolved_at is null and cause not like 'key_near_cap%'");
      assert.deepStrictEqual(flags, []);
    }],
    ['the terminal admin tool grants more credit through the admin door, and the key limit follows', async () => {
      // async on purpose: the dev server runs in this process, so a blocking call would never get its answer
      const { execFile } = require('child_process');
      const out = await new Promise((ok, fail) => execFile('node', [require('path').join(__dirname, 'tools/toolbox-admin.mjs'), 'grant', '--person', person, '--amount', '2', '--url', s.url],
        { env: { ...process.env, AI_ADMIN_SECRET: s.env.AI_ADMIN_SECRET }, encoding: 'utf8', timeout: 30000 }, (e, so) => (e ? fail(e) : ok(so))));
      assert.ok(/retry key: /.test(out) && /"ok": true/.test(out), out);
      const keyHash = (await psqlRows(DB, "select key_hash from public.tester_passes where id = '" + person + "'"))[0].key_hash;
      assert.strictEqual(s.mock.state.keys.get(keyHash).limit, 3, '$1 first grant + $2 = a $3 cap');
    }],
    ['revoke: the next ask is refused and the key is disabled at OpenRouter', async () => {
      const r = await (await post('admin', { action: 'revoke', person }, s.env.AI_ADMIN_SECRET)).json();
      assert.strictEqual(r.keyDisabled, true);
      const after = await post('route', { ask: 'hello', summary: {} }, tester);
      assert.deepStrictEqual([after.status, (await after.json()).reason], [401, 'disabled']);
    }],
    ['I6: no tester pass, provisioned key or prompt text in any log line or AI table', async () => {
      const keyText = 'sk-mock-';
      const tables = ['tester_passes', 'credit_ledger', 'ai_holds', 'ai_usage', 'route_tickets', 'ops_flags', 'gate_blocks', 'limit_updates', 'ai_outcomes'];
      const dump = JSON.stringify(await Promise.all(tables.map((tb) => psqlRows(DB, 'select * from public.' + tb))));
      for (const secret of [tester, ASK1, ASK2, 'croissants', 'a dream plan']) {
        assert.ok(!dump.includes(secret), 'tables hold: ' + secret.slice(0, 12));
        assert.ok(!logs.join('\n').includes(secret), 'logs hold: ' + secret.slice(0, 12));
      }
      assert.ok(!dump.includes(keyText), 'a provisioned key is stored in clear');
      assert.ok(!logs.join('\n').includes(keyText), 'a provisioned key reached a log');
    }]
  ];
  try { for (const [name, fn_] of tests) await t(name, fn_); }
  finally { await s.close(); console.error = origErr; }
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
