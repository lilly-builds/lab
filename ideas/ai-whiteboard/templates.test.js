/* node ideas/ai-whiteboard/templates.test.js
   Board Room (#209): gallery list shape, DB-first plan with community merge, payload load,
   anonymous instant publish (shaping + caps), the templatesEnabled gate, ?sync=off,
   fail-open, the anon-publish migration, and seed fidelity against the static files. */
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
      { slug: 'dream-board', title: 'Dream board', description: 'Sort it.', author_name: 'Priya N.', author_x: 'priya_makes', is_sample: true, status: 'published', published_at: '2026-10-12T10:00:00Z', payload: [{ id: 'e1', type: 'ellipse' }] },
      { slug: 'newer-one', title: 'Newer', description: 'why\n\nlove', author_name: null, author_x: null, is_sample: false, status: 'published', published_at: '2026-10-15T10:00:00Z', payload: [{ type: 'note' }] },
      { slug: 'pending-one', title: 'Hidden', description: '', author_name: 'X', author_x: null, is_sample: false, status: 'pending', payload: [] }
    ],
    inserted: [], insertError: null, clientOpts: null
  };
}
function fakeSb(server) {
  const published = () => server.rows.filter((r) => r.status === 'published');
  return {
    from: () => ({
      select: () => ({
        eq: (k, v) => {
          if (k === 'status') return { order: () => ({ then: (res, rej) => Promise.resolve({ data: published(), error: null }).then(res, rej) }) };
          if (k === 'slug') return { then: (res, rej) => Promise.resolve({ data: server.rows.filter((r) => r.slug === v), error: null }).then(res, rej) };
          throw new Error('unexpected eq ' + k);
        }
      }),
      insert: (row) => {
        server.inserted.push(row);
        if (server.insertError) return Promise.resolve({ data: null, error: server.insertError });
        server.rows.push(Object.assign({}, row));
        return Promise.resolve({ data: null, error: null });
      }
    })
  };
}
const ON = { url: 'https://proj.supabase.co', anonKey: 'k', enabled: false, templatesEnabled: true };
const mk = (server, win) => templates.create({
  win: Object.assign({ location: { search: '' }, AIWB_SUPABASE: ON }, win || {}),
  loadSupabase: async () => ({ createClient: (url, key, o) => { server.clientOpts = o; return fakeSb(server); } })
});
const sub = (over) => Object.assign({ title: 'My Board', why: 'it helps', love: 'the calm', author: 'Lilly', x: 'lilly', elements: [{ type: 'note' }] }, over || {});

const tests = [
  ['gallery list: published rows in manifest shape; pending hidden', async () => {
    const list = await mk(mkServer()).list();
    assert.strictEqual(list.length, 2, 'pending row hidden');
    assert.deepStrictEqual(list[0], {
      id: 'dream-board', title: 'Dream board', desc: 'Sort it.',
      author: 'Priya N.', x: 'priya_makes', sample: true,
      payload: [{ id: 'e1', type: 'ellipse' }], created: '2026-10-12T10:00:00Z'
    });
    assert.strictEqual(list[1].author, 'anonymous');
  }],
  ['gate: templatesEnabled opens the Board Room while board sync (enabled) stays off', async () => {
    const server = mkServer();
    assert(await mk(server).list(), 'reads work with enabled:false, templatesEnabled:true');
    assert.strictEqual((await mk(server).submit(sub())).ok, true, 'publish works too');
  }],
  ['gate: enabled alone does not open the Board Room; templatesEnabled false/missing = static', async () => {
    const server = mkServer();
    for (const cfg of [{ url: ON.url, anonKey: 'k', enabled: true }, { url: ON.url, anonKey: 'k', enabled: true, templatesEnabled: false }]) {
      const tm = mk(server, { AIWB_SUPABASE: cfg });
      assert.strictEqual(await tm.list(), null);
      assert.strictEqual(await tm.loadPayload('dream-board'), null);
      assert.strictEqual((await tm.submit(sub())).error, 'offline');
    }
    assert.strictEqual(server.inserted.length, 0, 'nothing written');
  }],
  ['the committed config opens templates and keeps sync dark', async () => {
    const w = {}; new Function('window', fs.readFileSync(path.join(__dirname, 'supabase-config.js'), 'utf8'))(w);
    assert.strictEqual(w.AIWB_SUPABASE.templatesEnabled, true);
    assert.strictEqual(w.AIWB_SUPABASE.enabled, false);
  }],
  ['gallery falls back to static on a placeholder project', async () => {
    const tm = mk(mkServer(), { AIWB_SUPABASE: { url: 'https://YOUR-PROJECT-REF.supabase.co', anonKey: 'k', templatesEnabled: true } });
    assert.strictEqual(await tm.list(), null, 'null means: use the static files');
  }],
  ['plan: DB first, samples for the built-in grid, community newest first', async () => {
    const db = await mk(mkServer()).list();
    const gh = [{ title: 'Old issue', why: 'w', author: 'A', x: '', elements: [], created: '2026-10-01T00:00:00Z' },
                { title: 'Mid issue', why: 'w', author: 'B', x: '', elements: [], created: '2026-10-14T00:00:00Z' }];
    const p = templates.plan(db, gh, '');
    assert.deepStrictEqual(p.samples.map((s) => s.id), ['dream-board']);
    assert.deepStrictEqual(p.community.map((c) => c.title), ['Newer', 'Mid issue', 'Old issue'], 'DB and GitHub merged, newest first');
    assert.strictEqual(p.highlight, null);
    assert.deepStrictEqual(p.community[0].elements, [{ type: 'note' }]);
  }],
  ['plan: the just-published card is pinned first and highlighted', async () => {
    const db = [
      { id: 'mine-ab12', title: 'Mine', desc: '', author: 'me', x: '', sample: false, payload: [{ type: 'note' }], created: '2026-10-10T00:00:00Z' },
      { id: 'other-cd34', title: 'Other', desc: '', author: 'o', x: '', sample: false, payload: [], created: '2026-10-15T00:00:00Z' }
    ];
    const p = templates.plan(db, [], 'mine-ab12');
    assert.strictEqual(p.community[0].id, 'mine-ab12');
    assert.strictEqual(p.highlight, 'mine-ab12');
    assert.strictEqual(templates.plan(db, [], 'missing-zz99').highlight, null);
  }],
  ['plan: DB unreachable falls back to static samples and GitHub community', async () => {
    const gh = [{ title: 'Issue', why: 'w', author: 'A', x: '', elements: [], created: '2026-10-01T00:00:00Z' }];
    const p = templates.plan(null, gh, '');
    assert.strictEqual(p.samples, null, 'null = use templates.json');
    assert.deepStrictEqual(p.community.map((c) => c.title), ['Issue'], 'existing community templates never vanish');
  }],
  ['plan: DB with no sample rows still shows the static built-ins', async () => {
    const p = templates.plan([{ id: 'a-b', title: 'T', desc: '', author: 'x', x: '', sample: false, payload: [], created: '2026-10-15T00:00:00Z' }], [], '');
    assert.strictEqual(p.samples, null);
    assert.strictEqual(p.community.length, 1);
  }],
  ['loadPayload returns the element array only for published rows', async () => {
    const tm = mk(mkServer());
    assert.deepStrictEqual(await tm.loadPayload('dream-board'), [{ id: 'e1', type: 'ellipse' }]);
    assert.strictEqual(await tm.loadPayload('pending-one'), null, 'pending never loads into a board');
    assert.strictEqual(await tm.loadPayload('nope'), null);
    assert.strictEqual(await tm.loadPayload('bad id!'), null, 'junk ids rejected before the query');
  }],
  ['anon publish: one published row, no session, no whole board', async () => {
    const server = mkServer();
    const r = await mk(server).submit(sub());
    assert(r.ok && r.mode === 'db' && /^my-board-[a-z0-9]{4}$/.test(r.slug), 'slug returned for ?published=');
    const row = server.inserted[0];
    assert.deepStrictEqual(Object.keys(row).sort(), ['author_name', 'author_x', 'description', 'payload', 'slug', 'status', 'title']);
    assert.strictEqual(row.status, 'published');
    assert.strictEqual(row.slug, r.slug);
    assert.strictEqual(row.description, 'it helps\n\nthe calm');
    assert.strictEqual(row.author_name, 'Lilly');
    assert.strictEqual(row.author_x, 'lilly');
    assert.deepStrictEqual(row.payload, [{ type: 'note' }]);
    assert.strictEqual(server.clientOpts.auth.persistSession, false, 'never an authenticated insert');
  }],
  ['anon publish: caps match the dialog (60/400/400/40/15, 120 elements)', async () => {
    const server = mkServer();
    const els = Array.from({ length: 300 }, (_, i) => ({ type: 'note', text: 'n' + i }));
    await mk(server).submit(sub({ title: 'T'.repeat(90), why: 'w'.repeat(900), love: 'l'.repeat(900), author: 'a'.repeat(90), elements: els }));
    const row = server.inserted[0];
    assert.strictEqual(row.title.length, 60);
    assert.strictEqual(row.description.length, 400 + 2 + 400);
    assert.strictEqual(row.author_name.length, 40);
    assert.strictEqual(row.payload.length, 120);
  }],
  ['anon publish: optional fields drop cleanly; bad X handle and junk elements never ship', async () => {
    const row = templates.shapeRow(sub({ author: '  ', x: 'not a handle!', elements: [null, 'str', [1], { type: 'note' }] }), 's-1234');
    assert.strictEqual(row.author_name, null);
    assert.strictEqual(row.author_x, null);
    assert.deepStrictEqual(row.payload, [{ type: 'note' }]);
    assert.strictEqual(templates.shapeRow(sub({ title: '   ' }), 's'), null);
    assert.strictEqual(templates.shapeRow(sub({ elements: [] }), 's'), null);
  }],
  ['publish: empty board is refused before any request', async () => {
    const server = mkServer();
    assert.strictEqual((await mk(server).submit(sub({ elements: [] }))).error, 'empty');
    assert.strictEqual(server.inserted.length, 0);
  }],
  ['publish: a slug collision retries once with a new slug; policy rejection is mapped', async () => {
    const server = mkServer();
    const tm = mk(server);
    server.insertError = { message: 'duplicate key value violates unique constraint' };
    assert.strictEqual((await tm.submit(sub())).error, 'rejected');
    assert.strictEqual(server.inserted.length, 2, 'retried once');
    assert.notStrictEqual(server.inserted[0].slug, server.inserted[1].slug);
    server.insertError = { message: 'new row violates row-level security policy' };
    assert.strictEqual((await tm.submit(sub())).error, 'rejected');
  }],
  ['?sync=off forces the static fallback everywhere', async () => {
    const server = mkServer();
    const tm = mk(server, { location: { search: '?sync=off' } });
    assert.strictEqual(await tm.list(), null, 'gallery uses static files');
    assert.strictEqual(await tm.loadPayload('dream-board'), null);
    assert.strictEqual((await tm.submit(sub())).error, 'offline');
    assert.strictEqual(server.inserted.length, 0, 'nothing written');
  }],
  ['a hanging backend fails open to static within the timeout', async () => {
    const tm = templates.create({ win: { location: { search: '' }, AIWB_SUPABASE: ON }, loadSupabase: () => new Promise(() => {}) });
    const t0 = Date.now();
    assert.strictEqual(await tm.list(), null, 'fell back to static');
    assert(Date.now() - t0 < 4000, 'inside the fail-open budget, not a hung page');
  }],
  ['migration: anon insert is published-only, capped, idempotent, and leaves sync policies alone', async () => {
    const dir = path.join(__dirname, 'supabase/migrations');
    const file = fs.readdirSync(dir).filter((f) => /anon_template_publish\.sql$/.test(f))[0];
    assert(file && /^\d{12}_/.test(file), 'timestamp-prefixed file');
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    assert.strictEqual(all[all.length - 1], file, 'applies last, after the policies it builds on');
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    assert(/drop policy if exists templates_anon_publish/.test(sql) && /create policy templates_anon_publish[\s\S]*for insert to anon/.test(sql));
    assert(/status = 'published'[\s\S]*author_user_id is null[\s\S]*is_sample = false/.test(sql), 'no attribution, never a sample');
    assert(/grant insert \(slug, title, description, author_name, author_x, payload, status\)\s+on public\.templates to anon/.test(sql), 'column grant keeps anon off moderator fields');
    assert(!/published_at|is_sample, |author_user_id,/.test(sql.split('grant insert')[1]), 'moderator columns not granted');
    assert(/jsonb_typeof\(payload\) = 'array'/.test(sql));
    const C = templates.CAPS;
    assert(new RegExp('between 1 and ' + C.title + '\\b').test(sql), 'title cap');
    assert(new RegExp('char_length\\(description\\) <= ' + (C.why + C.love + 2) + '\\b').test(sql), 'description cap');
    assert(new RegExp('char_length\\(author_name\\) <= ' + C.author + '\\b').test(sql), 'author cap');
    assert(new RegExp('\\{1,' + C.x + '\\}').test(sql), 'x handle cap');
    assert(new RegExp('jsonb_array_length\\(payload\\) <= ' + C.elements + '\\b').test(sql), 'element cap');
    assert((sql.match(/if not exists \(select 1 from pg_constraint/g) || []).length === 2, 'constraints guarded so a second apply is a no-op');
    assert(!/alter policy|drop policy (if exists )?(templates_author|templates_read|boards|board_)/i.test(sql), 'existing policies untouched');
    assert(!/author_user_id\s+(set|drop)|alter column author_user_id/i.test(sql), 'author_user_id already nullable, not altered');
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
