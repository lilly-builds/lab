/* node ideas/ai-whiteboard/templates.test.js
   Board Room (#209): server-paged gallery reads (newest first, no payloads), GitHub merge across
   pages, payload load, anonymous instant publish (shaping, caps, collision retry, same-slug retry
   after a timeout), the templatesEnabled gate, ?sync=off, fail-open, and the anon-publish migration
   (checked statically: no Postgres here). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const templates = require('./templates.js');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

const community = (i, over) => Object.assign({
  slug: 'c-' + String(i).padStart(3, '0'), title: 'Community ' + i, description: 'd' + i, author_name: null, author_x: null,
  is_sample: false, status: 'published', published_at: new Date(Date.UTC(2026, 9, 1) + i * 3600e3).toISOString(), payload: [{ type: 'note', text: 'p' + i }]
}, over || {});

function mkServer(extra) {
  return {
    rows: [
      { slug: 'dream-board', title: 'Dream board', description: 'Sort it.', author_name: 'Priya N.', author_x: 'priya_makes', is_sample: true, status: 'published', published_at: '2026-10-12T10:00:00Z', payload: [{ id: 'e1', type: 'ellipse' }] },
      { slug: 'newer-one', title: 'Newer', description: 'why\n\nlove', author_name: null, author_x: null, is_sample: false, status: 'published', published_at: '2026-10-15T10:00:00Z', payload: [{ type: 'note' }] },
      { slug: 'pending-one', title: 'Hidden', description: '', author_name: 'X', author_x: null, is_sample: false, status: 'pending', payload: [] }
    ].concat(extra || []),
    inserted: [], insertError: null, clientOpts: null, queries: [], onInsert: null
  };
}
/* a query builder with the PostgREST chain the module uses: select/eq/order/range, awaited */
function fakeSb(server) {
  return {
    from: () => ({
      select: (cols) => {
        const q = { cols, eq: [], order: [], range: null };
        server.queries.push(q);
        const b = {
          eq: (k, v) => { q.eq.push([k, v]); return b; },
          order: (k, o) => { q.order.push([k, !o || o.ascending !== false]); return b; },
          range: (a, z) => { q.range = [a, z]; return b; },
          then: (res, rej) => {
            let rows = server.rows.filter((r) => q.eq.every(([k, v]) => r[k] === v));
            q.order.slice().reverse().forEach(([k, asc]) => { rows = rows.slice().sort((x, y) => (x[k] < y[k] ? -1 : x[k] > y[k] ? 1 : 0) * (asc ? 1 : -1)); });
            if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
            const keep = String(cols).split(',');
            rows = rows.map((r) => { const o = {}; keep.forEach((k) => { o[k] = r[k]; }); return o; });
            return Promise.resolve({ data: rows, error: null }).then(res, rej);
          }
        };
        return b;
      },
      insert: (row) => {
        server.inserted.push(row);
        if (server.onInsert) return server.onInsert(row, server.inserted.length);
        if (server.insertError) return Promise.resolve({ data: null, error: server.insertError });
        server.rows.push(Object.assign({}, row));
        return Promise.resolve({ data: null, error: null });
      }
    })
  };
}
const ON = { url: 'https://proj.supabase.co', anonKey: 'k', enabled: false, templatesEnabled: true };
const mk = (server, win, extra) => templates.create(Object.assign({
  win: Object.assign({ location: { search: '' }, AIWB_SUPABASE: ON }, win || {}),
  loadSupabase: async () => ({ createClient: (url, key, o) => { server.clientOpts = o; return fakeSb(server); } })
}, extra || {}));
const sub = (over) => Object.assign({ title: 'My Board', why: 'it helps', love: 'the calm', author: 'Lilly', x: 'lilly', elements: [{ type: 'note' }] }, over || {});
const migration = () => {
  const dir = path.join(__dirname, 'supabase/migrations');
  const file = fs.readdirSync(dir).filter((f) => /anon_template_publish\.sql$/.test(f))[0];
  return { dir, file, sql: fs.readFileSync(path.join(dir, file), 'utf8') };
};

const tests = [
  ['samples: published sample rows in gallery shape, no payload requested, pending hidden', async () => {
    const server = mkServer();
    const list = await mk(server).samples();
    assert.strictEqual(list.length, 1);
    assert.deepStrictEqual(list[0], {
      id: 'dream-board', title: 'Dream board', desc: 'Sort it.', author: 'Priya N.', x: 'priya_makes',
      sample: true, created: '2026-10-12T10:00:00Z', payload: null, lazy: true
    });
    assert(!/payload/.test(server.queries[0].cols), 'list rows never carry the payload');
  }],
  ['page: newest first, 24 a page, ordered and ranged by the server, no payloads', async () => {
    const server = mkServer(Array.from({ length: 30 }, (_, i) => community(i)));
    const tm = mk(server);
    const p0 = await tm.page(0);
    assert.strictEqual(p0.rows.length, 24);
    assert.strictEqual(p0.more, true);
    assert.strictEqual(p0.rows[0].id, 'newer-one', 'newest published row first');
    assert.strictEqual(p0.rows[1].id, 'c-029');
    const q = server.queries[0];
    assert.deepStrictEqual(q.order[0], ['published_at', false], 'server sorts newest first');
    assert.deepStrictEqual(q.range, [0, 24], 'one extra row asks whether another page exists');
    assert(!/payload/.test(q.cols));
    assert(q.eq.some(([k, v]) => k === 'is_sample' && v === false) && q.eq.some(([k, v]) => k === 'status' && v === 'published'));
    const p1 = await tm.page(1);
    assert.deepStrictEqual(server.queries[1].range, [24, 48]);
    assert.strictEqual(p1.rows.length, 7, 'the other 31 community rows minus the first 24');
    assert.strictEqual(p1.more, false);
    assert.strictEqual(p1.rows[p1.rows.length - 1].id, 'c-000', 'oldest last');
    const ids = p0.rows.concat(p1.rows).map((r) => r.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'no row twice across pages');
  }],
  ['page: oversized rows cost nothing extra - payloads are fetched per card', async () => {
    const big = community(1, { payload: [{ type: 'note', text: 'x'.repeat(500000) }] });
    const server = mkServer([big]);
    const tm = mk(server);
    const p = await tm.page(0);
    assert(p.rows.every((r) => r.payload === null && r.lazy), 'a list row is metadata only');
    assert.strictEqual((await tm.loadPayload('c-001'))[0].text.length, 500000, 'one card, one payload fetch');
  }],
  ['one: the just-published row by slug, published only', async () => {
    const tm = mk(mkServer());
    assert.strictEqual((await tm.one('newer-one')).title, 'Newer');
    assert.strictEqual(await tm.one('pending-one'), null);
    assert.strictEqual(await tm.one('bad id!'), null);
  }],
  ['gate: templatesEnabled opens the Board Room while board sync (enabled) stays off', async () => {
    const server = mkServer();
    assert(await mk(server).page(0), 'reads work with enabled:false, templatesEnabled:true');
    assert.strictEqual((await mk(server).submit(sub())).ok, true, 'publish works too');
  }],
  ['gate: enabled alone does not open the Board Room; templatesEnabled false/missing = static', async () => {
    const server = mkServer();
    for (const cfg of [{ url: ON.url, anonKey: 'k', enabled: true }, { url: ON.url, anonKey: 'k', enabled: true, templatesEnabled: false }]) {
      const tm = mk(server, { AIWB_SUPABASE: cfg });
      assert.strictEqual(await tm.samples(), null);
      assert.strictEqual(await tm.page(0), null);
      assert.strictEqual(await tm.one('newer-one'), null);
      assert.strictEqual(await tm.loadPayload('dream-board'), null);
      assert.strictEqual((await tm.submit(sub())).error, 'offline');
    }
    assert.strictEqual(server.inserted.length, 0, 'nothing written');
    assert.strictEqual(server.queries.length, 0, 'nothing read');
  }],
  ['the committed config opens templates and keeps sync dark', async () => {
    const w = {}; new Function('window', fs.readFileSync(path.join(__dirname, 'supabase-config.js'), 'utf8'))(w);
    assert.strictEqual(w.AIWB_SUPABASE.templatesEnabled, true);
    assert.strictEqual(w.AIWB_SUPABASE.enabled, false);
  }],
  ['gallery falls back to static on a placeholder project', async () => {
    const tm = mk(mkServer(), { AIWB_SUPABASE: { url: 'https://YOUR-PROJECT-REF.supabase.co', anonKey: 'k', templatesEnabled: true } });
    assert.strictEqual(await tm.page(0), null, 'null means: use the static files and GitHub');
    assert.strictEqual(await tm.samples(), null);
  }],
  ['a failing database read is null (fall back), never a throw or an empty gallery', async () => {
    const tm = templates.create({ win: { location: { search: '' }, AIWB_SUPABASE: ON },
      loadSupabase: async () => ({ createClient: () => ({ from: () => ({ select: () => { throw new Error('boom'); } }) }) }) });
    assert.strictEqual(await tm.page(0), null);
    assert.strictEqual(await tm.samples(), null);
    assert.strictEqual(await tm.one('x-1'), null);
  }],
  ['mergePage: GitHub items are released newest first, only down to the oldest row of the page', async () => {
    const db = [{ id: 'a', created: '2026-10-15T00:00:00Z' }, { id: 'b', created: '2026-10-10T00:00:00Z' }];
    const gh = [{ id: 'g1', created: '2026-10-14T00:00:00Z' }, { id: 'g2', created: '2026-10-11T00:00:00Z' }, { id: 'g3', created: '2026-10-01T00:00:00Z' }];
    const m = templates.mergePage(db, true, gh);
    assert.deepStrictEqual(m.items.map((i) => i.id), ['a', 'g1', 'g2', 'b'], 'merged by date');
    assert.deepStrictEqual(m.rest.map((i) => i.id), ['g3'], 'older than this page: waits for the next');
    const last = templates.mergePage([], false, m.rest);
    assert.deepStrictEqual(last.items.map((i) => i.id), ['g3'], 'no more database pages: everything left is released');
    assert.strictEqual(last.rest.length, 0, 'nothing vanishes');
    const late = templates.mergePage([], true, gh, '2026-10-10T00:00:00Z');
    assert.deepStrictEqual(late.items.map((i) => i.id), ['g1', 'g2'], 'late GitHub items use the last row read as the cutoff');
  }],
  ['mergePage: database unreachable leaves the whole GitHub pool alone for the caller to page', async () => {
    const gh = [{ id: 'g1', created: '2026-10-14T00:00:00Z' }];
    assert.deepStrictEqual(templates.mergePage(null, false, gh).items.map((i) => i.id), ['g1']);
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
  ['anon publish: zero-width / bidi / filler-only title is refused, author falls back to anonymous', async () => {
    for (const bad of ['​', '​‌‍', 'ㅤ', '‮‬', ' ⁠ ﻿ ', '­']) {
      assert.strictEqual(templates.shapeRow(sub({ title: bad }), 's-1'), null, JSON.stringify(bad) + ' as a title');
      assert.strictEqual(templates.shapeRow(sub({ author: bad }), 's-1').author_name, null, JSON.stringify(bad) + ' as an author');
    }
    assert.strictEqual(templates.shapeRow(sub({ title: '​hi' }), 's-1').title, '​hi', 'one visible character is enough');
    assert.strictEqual(templates.shapeRow(sub({ title: 'مرحبا' }), 's-1').title, 'مرحبا', 'other scripts are visible');
  }],
  ['publish: empty board is refused before any request', async () => {
    const server = mkServer();
    assert.strictEqual((await mk(server).submit(sub({ elements: [] }))).error, 'empty');
    assert.strictEqual((await mk(server).submit(sub({ title: '​' }))).error, 'empty');
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
  ['publish: a collision matched by SQLSTATE 23505 retries and can succeed', async () => {
    const server = mkServer();
    server.onInsert = (row, call) => Promise.resolve(call === 1 ? { error: { code: '23505', message: 'x' } } : (server.rows.push(Object.assign({}, row)), { error: null }));
    const r = await mk(server).submit(sub());
    assert(r.ok);
    assert.strictEqual(server.inserted.length, 2);
    assert.strictEqual(r.slug, server.inserted[1].slug);
    assert.notStrictEqual(server.inserted[0].slug, server.inserted[1].slug);
  }],
  ['publish: the rate cap maps to busy', async () => {
    const server = mkServer();
    server.insertError = { message: 'publish rate limit', code: '23514' };
    assert.strictEqual((await mk(server).submit(sub())).error, 'busy');
    assert.strictEqual(server.inserted.length, 1, 'no retry into a rate limit');
  }],
  ['publish: a timeout retries with the SAME slug; the first request having landed is a success, not a twin', async () => {
    const server = mkServer();
    server.onInsert = (row, call) => {
      if (call === 1) { server.rows.push(Object.assign({}, row)); return new Promise(() => {}); } /* landed, but the answer never comes */
      return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
    };
    const r = await mk(server, null, { publishTimeoutMs: 20 }).submit(sub());
    assert(r.ok, 'a duplicate after a timeout means the first request landed');
    assert.strictEqual(server.inserted.length, 2);
    assert.strictEqual(server.inserted[0].slug, server.inserted[1].slug, 'same slug both times');
    assert.strictEqual(server.rows.filter((x) => x.slug === r.slug).length, 1, 'one row');
  }],
  ['publish: a timeout whose retry succeeds publishes once under that slug', async () => {
    const server = mkServer();
    server.onInsert = (row, call) => call === 1 ? new Promise(() => {}) : (server.rows.push(Object.assign({}, row)), Promise.resolve({ error: null }));
    const r = await mk(server, null, { publishTimeoutMs: 20 }).submit(sub());
    assert(r.ok && r.slug === server.inserted[0].slug);
  }],
  ['publish: two timeouts say offline, and tapping Share again reuses the slug', async () => {
    const server = mkServer();
    server.onInsert = () => new Promise(() => {});
    const tm = mk(server, null, { publishTimeoutMs: 20 });
    assert.strictEqual((await tm.submit(sub())).error, 'offline');
    assert.strictEqual(server.inserted.length, 2);
    await tm.submit(sub());
    assert.strictEqual(server.inserted.length, 4);
    assert.strictEqual(new Set(server.inserted.map((r) => r.slug)).size, 1, 'one slug across every attempt: a landed request can only ever be a duplicate');
    await tm.submit(sub({ title: 'Something else' }));
    assert.notStrictEqual(server.inserted[4].slug, server.inserted[0].slug, 'a different board gets its own slug');
  }],
  ['?sync=off forces the static fallback everywhere', async () => {
    const server = mkServer();
    const tm = mk(server, { location: { search: '?sync=off' } });
    assert.strictEqual(await tm.page(0), null, 'gallery uses static files');
    assert.strictEqual(await tm.samples(), null);
    assert.strictEqual(await tm.loadPayload('dream-board'), null);
    assert.strictEqual((await tm.submit(sub())).error, 'offline');
    assert.strictEqual(server.inserted.length, 0, 'nothing written');
  }],
  ['a hanging backend fails open to static within the timeout', async () => {
    const tm = templates.create({ win: { location: { search: '' }, AIWB_SUPABASE: ON }, loadSupabase: () => new Promise(() => {}) });
    const t0 = Date.now();
    assert.strictEqual(await tm.page(0), null, 'fell back to static');
    assert(Date.now() - t0 < 4000, 'inside the fail-open budget, not a hung page');
  }],
  ['a hanging query fails open too', async () => {
    const tm = templates.create({ win: { location: { search: '' }, AIWB_SUPABASE: ON }, timeoutMs: 30,
      loadSupabase: async () => ({ createClient: () => ({ from: () => ({ select: () => { const b = { eq: () => b, order: () => b, range: () => b, then: () => {} }; return b; } }) }) }) });
    assert.strictEqual(await tm.page(0), null);
  }],
  ['migration: anon insert is published-only, capped, idempotent, and leaves sync policies alone', async () => {
    const { dir, file, sql } = migration();
    assert(file && /^\d{12}_/.test(file), 'timestamp-prefixed file');
    // Applies after every other migration that touches public.templates, so nothing later can undo its policies.
    // Migrations for other tables (the AI toolbox's, for one) may sort after it.
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const touching = all.filter((f) => f !== file && /public\.templates\b/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert(touching.length >= 2, 'found the migrations it builds on');
    assert(touching.every((f) => f < file), 'applies after the policies it builds on: ' + touching.filter((f) => f > file).join(', '));
    assert(/drop policy if exists templates_anon_publish/.test(sql) && /create policy templates_anon_publish[\s\S]*for insert to anon/.test(sql));
    assert(/status = 'published'[\s\S]*author_user_id is null[\s\S]*is_sample = false/.test(sql), 'no attribution, never a sample');
    const grant = sql.match(/grant insert \(([^)]*)\)\s+on public\.templates to anon/);
    assert(grant, 'column grant');
    assert.strictEqual(grant[1].replace(/\s+/g, ' '), 'slug, title, description, author_name, author_x, payload, status', 'column grant keeps anon off moderator fields');
    assert(/jsonb_typeof\(payload\) = 'array'/.test(sql));
    const C = templates.CAPS;
    assert(new RegExp('between 1 and ' + C.title + '\\b').test(sql), 'title cap');
    assert(new RegExp('char_length\\(description\\) <= ' + (C.why + C.love + 2) + '\\b').test(sql), 'description cap');
    assert(new RegExp('char_length\\(author_name\\) <= ' + C.author + '\\b').test(sql), 'author cap');
    assert(new RegExp('\\{1,' + C.x + '\\}').test(sql), 'x handle cap');
    assert(new RegExp('jsonb_array_length\\(payload\\) <= ' + C.elements + '\\b').test(sql), 'element cap');
    assert(/octet_length\(payload::text\) <= 600000/.test(sql), 'size cap');
    assert((sql.match(/if not exists \(select 1 from pg_constraint/g) || []).length === 3, 'constraints guarded so a second apply is a no-op');
    assert(/create or replace function/.test(sql) && /drop trigger if exists templates_anon_rate/.test(sql) && /create index if not exists/.test(sql), 'functions, trigger and indexes re-apply cleanly');
    assert(!/alter policy|drop policy (if exists )?(templates_author|templates_read|boards|board_)/i.test(sql), 'existing policies untouched');
    assert(!/author_user_id\s+(set|drop)|alter column author_user_id/i.test(sql), 'author_user_id already nullable, not altered');
  }],
  ['migration: every payload element must be a jsonb object', async () => {
    const { sql } = migration();
    assert(/function public\.jsonb_all_objects\(j jsonb\)[\s\S]*jsonb_typeof\(e\) <> 'object'/.test(sql));
    assert(/case when jsonb_typeof\(j\) = 'array'[\s\S]*else false end/.test(sql), 'a non-array is false, never an error');
    assert(/templates_payload_caps[\s\S]*public\.jsonb_all_objects\(payload\)/.test(sql), 'wired into the payload CHECK');
  }],
  ['migration: title and author need a visible character, same set as the client', async () => {
    const { sql } = migration();
    const cls = sql.match(/title ~ '\[\^([^']*)\]'/);
    assert(cls, 'title visible-character regex');
    assert(sql.indexOf("author_name ~ '[^" + cls[1] + "]'") >= 0, 'author uses the same class');
    ['u00AD', 'u034F', 'u115F', 'u1160', 'u17B4', 'u17B5', 'u180E', 'u200B-\\u200F', 'u202A-\\u202E', 'u2060-\\u206F', 'u3164', 'uFEFF', 'uFFA0'].forEach((c) => {
      assert(cls[1].indexOf('\\' + c) >= 0, 'database class has \\' + c);
    });
    assert(cls[1].indexOf('[:space:]') >= 0);
  }],
  ['migration: the built-in template slugs are reserved for sample rows', async () => {
    const { sql } = migration();
    const m = sql.match(/templates_reserved_slugs check \(\s*is_sample or slug <> all \(array\[([^\]]*)\]\)/);
    assert(m, 'reservation CHECK present');
    const reserved = m[1].match(/'[^']+'/g).map((s) => s.slice(1, -1)).sort();
    const ids = JSON.parse(fs.readFileSync(path.join(__dirname, '../templates/templates.json'), 'utf8')).map((e) => e.id).sort();
    assert.deepStrictEqual(reserved, ids, 'reserved list = every id in templates.json (add a built-in, extend the list)');
    ids.forEach((id) => {
      assert(/^[a-z0-9-]{1,40}$/.test(id), id + ' is a legal slug, so only the reservation keeps it out');
    });
  }],
  ['migration: anon inserts are rate capped by a before-insert trigger', async () => {
    const { sql } = migration();
    assert(/create or replace function public\.templates_anon_rate\(\)[\s\S]*security definer[\s\S]*set search_path/.test(sql), 'definer with a pinned search_path');
    assert(/create trigger templates_anon_rate\s+before insert on public\.templates\s+for each row/.test(sql));
    assert(/author_user_id is null and not new\.is_sample/.test(sql), 'only unattributed, non-sample inserts count');
    assert(/interval '1 minute'\) >= \d+/.test(sql) && /interval '1 hour'\) >= \d+/.test(sql), 'a per-minute and a per-hour cap');
    assert(/rate limit/.test(sql) && /errcode = 'check_violation'/.test(sql));
  }],
  ['gallery page: GitHub fetch is raced against a timeout and database rows render on arrival', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../templates/index.html'), 'utf8');
    assert(/new AbortController\(\)/.test(html) && /GH_MS = 4000/.test(html) && /signal: ctl/.test(html), 'AbortController with a deadline');
    assert(/Promise\.race\(\[fetch\(API/.test(html), 'and a race for runtimes that ignore the signal');
    assert(/T\.page\(0\)/.test(html) && /ghP\.then/.test(html), 'database page 0 is not gated on GitHub');
    assert(!/select\([^)]*payload/.test(html), 'the page never selects payloads');
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
