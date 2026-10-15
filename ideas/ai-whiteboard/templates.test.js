/* node ideas/ai-whiteboard/templates.test.js
   U8: gallery list shape, payload load, pending submit with attribution,
   offline fallback, and seed fidelity against the static files. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const templates = require('./templates.js');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

function mkServer() {
  return {
    rows: [
      { slug: 'dream-board', title: 'Dream board', description: 'Sort it.', author_name: 'Priya N.', author_x: 'priya_makes', is_sample: true, status: 'published', payload: [{ id: 'e1', type: 'ellipse' }] },
      { slug: 'pending-one', title: 'Hidden', description: '', author_name: 'X', author_x: null, is_sample: false, status: 'pending', payload: [] }
    ],
    inserted: [], insertError: null
  };
}
function fakeSb(server) {
  const published = () => server.rows.filter((r) => r.status === 'published');
  return {
    from: () => ({
      select: (cols) => ({
        eq: (k, v) => {
          if (k === 'status') return { order: () => ({ then: (res) => Promise.resolve({ data: published(), error: null }).then(res) }) };
          if (k === 'slug') return { then: (res) => Promise.resolve({ data: server.rows.filter((r) => r.slug === v), error: null }).then(res) };
          throw new Error('unexpected eq ' + k);
        }
      }),
      insert: (row) => {
        server.inserted.push(row);
        if (server.insertError) return { select: () => Promise.resolve({ data: null, error: server.insertError }) };
        server.rows.push(Object.assign({ status: 'pending' }, row));
        return { select: () => Promise.resolve({ data: [{ slug: row.slug }], error: null }) };
      }
    })
  };
}
const mkSession = (server, state) => ({ state: state || 'online', client: fakeSb(server), userId: 'u1' });

const tests = [
  ['gallery list: published rows in manifest shape; pending hidden (AE5)', async () => {
    const server = mkServer();
    const tm = templates.create({ win: {}, session: mkSession(server) });
    const list = await tm.list();
    assert.strictEqual(list.length, 1, 'pending row hidden');
    assert.deepStrictEqual(list[0], {
      id: 'dream-board', title: 'Dream board', desc: 'Sort it.',
      author: 'Priya N.', x: 'priya_makes', sample: true,
      payload: [{ id: 'e1', type: 'ellipse' }]
    });
  }],
  ['gallery falls back to static when there is no client (signed-out, flag off)', async () => {
    const tm = templates.create({ win: { AIWB_SUPABASE: { url: 'https://YOUR-PROJECT-REF.supabase.co', anonKey: 'k' } }, session: null });
    assert.strictEqual(await tm.list(), null, 'null means: use the static files');
  }],
  ['loadPayload returns the element array only for published rows', async () => {
    const server = mkServer();
    const tm = templates.create({ win: {}, session: mkSession(server) });
    assert.deepStrictEqual(await tm.loadPayload('dream-board'), [{ id: 'e1', type: 'ellipse' }]);
    assert.strictEqual(await tm.loadPayload('pending-one'), null, 'pending never loads into a board');
    assert.strictEqual(await tm.loadPayload('nope'), null);
    assert.strictEqual(await tm.loadPayload('bad id!'), null, 'junk ids rejected before the query');
  }],
  ['share when synced: pending row with attribution (R13)', async () => {
    const server = mkServer();
    const tm = templates.create({ win: {}, session: mkSession(server) });
    const r = await tm.submit({ title: 'My Board', why: 'it helps', love: 'the calm', author: 'Lilly', x: 'lilly', elements: [{ id: 'a1', type: 'note' }] });
    assert(r.ok && r.mode === 'db');
    const row = server.inserted[0];
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.title, 'My Board');
    assert.strictEqual(row.description, 'it helps\n\nthe calm');
    assert.strictEqual(row.author_name, 'Lilly');
    assert.strictEqual(row.author_x, 'lilly');
    assert.deepStrictEqual(row.payload, [{ id: 'a1', type: 'note' }]);
    assert(/^my-board-[a-z0-9]{4}$/.test(row.slug), 'clean slug with suffix: ' + row.slug);
  }],
  ['the per-author cap and policy rejections come back as mapped errors', async () => {
    const server = mkServer();
    const tm = templates.create({ win: {}, session: mkSession(server) });
    server.insertError = { message: 'pending template cap reached' };
    assert.strictEqual((await tm.submit({ title: 'T', why: 'w', elements: [{ id: 'a' }] })).error, 'cap');
    server.insertError = { message: 'row-level security' };
    assert.strictEqual((await tm.submit({ title: 'T', why: 'w', elements: [{ id: 'a' }] })).error, 'rejected');
  }],
  ['share offline: caller falls back to the issue flow', async () => {
    const server = mkServer();
    const tm = templates.create({ win: {}, session: mkSession(server, 'offline') });
    const r = await tm.submit({ title: 'T', why: 'w', elements: [{ id: 'a' }] });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(server.inserted.length, 0, 'nothing attempted offline');
  }],
  ['?sync=off forces the static fallback everywhere, even with an online session', async () => {
    const server = mkServer();
    const win = { location: { search: '?sync=off' } };
    const tm = templates.create({ win, session: mkSession(server) });
    assert.strictEqual(await tm.list(), null, 'gallery uses static files');
    assert.strictEqual(await tm.loadPayload('dream-board'), null);
    const r = await tm.submit({ title: 'T', why: 'w', elements: [{ id: 'a' }] });
    assert.strictEqual(r.error, 'offline', 'share falls back to the issue flow');
    assert.strictEqual(server.inserted.length, 0, 'nothing written');
  }],
  ['a hanging backend fails open to static within the timeout', async () => {
    const win = { location: { search: '' }, AIWB_SUPABASE: { url: 'https://proj.supabase.co', anonKey: 'k', enabled: true } };
    const tm = templates.create({ win, session: null, loadSupabase: () => new Promise(() => {}) });
    const t0 = Date.now();
    assert.strictEqual(await tm.list(), null, 'fell back to static');
    assert(Date.now() - t0 < 4000, 'inside the fail-open budget, not a hung page');
  }],
  ['seed rows match the static files in title, author, sample and payload', async () => {
    const seed = fs.readFileSync(path.join(__dirname, 'supabase/seed/templates_seed.sql'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../templates/templates.json'), 'utf8'));
    manifest.forEach((entry) => {
      const payload = JSON.parse(fs.readFileSync(path.join(__dirname, '../templates', entry.file), 'utf8'));
      const lit = "'" + JSON.stringify(payload).replace(/'/g, "''") + "'::jsonb";
      assert(seed.indexOf(lit) >= 0, 'seed carries the exact payload of ' + entry.file);
      assert(seed.indexOf("'" + entry.title.replace(/'/g, "''") + "'") >= 0, 'seed carries the title of ' + entry.id);
    });
    const rowCount = (seed.match(/::jsonb, 'published'/g) || []).length;
    assert.strictEqual(rowCount, manifest.length, 'one published seed row per manifest entry');
    assert(seed.indexOf('on conflict (slug) do nothing') >= 0, 'reseed is idempotent');
  }]
];

(async () => {
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
