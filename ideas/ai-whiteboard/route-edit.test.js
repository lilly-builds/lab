/* node ideas/ai-whiteboard/route-edit.test.js
   Runs the ROUTE-PURE and EDIT-PURE blocks of app-09-route.js: classifier-reply parser and edit-op validator. */
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, 'app-09-route.js'), 'utf8');
const block = (name) => { const m = src.match(new RegExp('/\\* ' + name + '-PURE-BEGIN[^\\n]*\\n([\\s\\S]*?)/\\* ' + name + '-PURE-END \\*/')); assert(m, name + ' block not found'); return m[1]; };
const lib = new Function(block('ROUTE') + block('EDIT') + '; return { parseRoute, needsAsk, buildRouteSystem, validateEditOps, needsDeleteConfirm };')();

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

/* ---- classifier reply parser ---- */
const routes = { draw: { label: 'Answer or draw', about: 'a question.' }, build: { label: 'Build an app', about: 'an app.' }, edit: { label: 'Change the board', about: 'changes.' } };
const P = (s) => lib.parseRoute(s, routes);
t('plain json', () => assert.deepStrictEqual(P('{"route":"edit","confidence":0.9}'), { route: 'edit', confidence: 0.9, ask: null, steps: ['edit'] }));
t('fenced json with prose', () => assert.strictEqual(P('Sure!\n```json\n{"route":"build","confidence":1}\n```').route, 'build'));
t('first object wins', () => assert.strictEqual(P('{"route":"draw"} {"route":"edit"}').route, 'draw'));
t('braces inside strings', () => assert.strictEqual(P('{"ask":"use } here","route":"draw","confidence":0.4}').ask, 'use } here'));
t('unknown route rejected', () => assert.strictEqual(P('{"route":"delete-everything","confidence":1}'), null));
t('inherited key is not a route', () => assert.strictEqual(P('{"route":"constructor"}'), null));
t('junk, empty and non-string rejected', () => { assert.strictEqual(P('no json here'), null); assert.strictEqual(P('{"route":'), null); assert.strictEqual(P(''), null); assert.strictEqual(P(null), null); assert.strictEqual(P('[1,2]'), null); });
t('confidence clamped, missing defaults to confident', () => { assert.strictEqual(P('{"route":"draw","confidence":7}').confidence, 1); assert.strictEqual(P('{"route":"draw","confidence":-3}').confidence, 0); assert.strictEqual(P('{"route":"draw"}').confidence, 0.8); assert.strictEqual(P('{"route":"draw","confidence":"high"}').confidence, 0.8); });
t('steps: valid only, max 2', () => { assert.deepStrictEqual(P('{"route":"build","steps":["build","nope","edit","draw"]}').steps, ['build', 'edit']); assert.strictEqual(P('{"steps":["edit","draw"]}').route, 'edit'); });
t('needsAsk by confidence or ask', () => { assert(lib.needsAsk(P('{"route":"draw","confidence":0.59}'))); assert(!lib.needsAsk(P('{"route":"draw","confidence":0.6}'))); assert(lib.needsAsk(P('{"route":"draw","confidence":0.9,"ask":"Which one?"}'))); });
t('system prompt is built from the table', () => { const s = lib.buildRouteSystem(routes); assert(/draw\|build\|edit/.test(s)); assert(s.includes('build (Build an app): an app.')); });

/* ---- edit-op validator ---- */
const ctx = {
  items: { n1: { type: 'note' }, n2: { type: 'note' }, n3: { type: 'note' }, t1: { type: 'text' }, r1: { type: 'rect' }, a1: { type: 'arrow' }, i1: { type: 'image' }, e1: { type: 'embed' }, app: { type: 'embed', kind: 'app' } },
  zones: { r1: true },
  strokes: ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00'],
  fills: ['none', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99', '#ffffff'],
  noteFills: ['#bfd7ff', '#ffec99', '#b2f2bb', '#ffc9c9']
};
const V = (ops) => lib.validateEditOps(ops, ctx).ops;
t('non-array input gives nothing', () => { assert.deepStrictEqual(V(null), []); assert.deepStrictEqual(V({}), []); });
t('unknown op and unknown id dropped', () => assert.deepStrictEqual(V([{ op: 'explode', id: 'n1' }, { op: 'move', id: 'zzz', x: 1, y: 2 }, { op: 'move', id: '__proto__', x: 1, y: 2 }, { op: 'create', id: 'n1' }]), []));
t('move keeps valid, rejects NaN, Infinity and non-numbers', () => {
  assert.strictEqual(V([{ op: 'move', id: 'n1', x: 10, y: 20 }]).length, 1);
  assert.strictEqual(V([{ op: 'move', id: 'n1', x: NaN, y: 20 }, { op: 'move', id: 'n1', x: Infinity, y: 0 }, { op: 'move', id: 'n1', x: null, y: 0 }, { op: 'move', id: 'n1', x: '', y: 0 }, { op: 'move', id: 'n1', x: true, y: 0 }]).length, 0);
});
t('resize clamps and limits types', () => {
  const r = V([{ op: 'resize', id: 'r1', width: 5000, height: 2 }, { op: 'resize', id: 'n1', width: 100, height: 100 }, { op: 'resize', id: 'e1', width: 10, height: 10 }]);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual([r[0].width, r[0].height], [800, 24]);
  assert.deepStrictEqual([r[1].width, r[1].height], [160, 120]);
});
t('style only takes palette values', () => {
  assert.deepStrictEqual(V([{ op: 'style', id: 'n1', fill: '#A5D8FF' }]), []);
  assert.deepStrictEqual(V([{ op: 'style', id: 'n1', fill: '#ffc9c9' }])[0].set, { fill: '#ffc9c9' });
  assert.deepStrictEqual(V([{ op: 'style', id: 'r1', strokeColor: '#1971C2', fill: 'red', strokeWidth: 3, dashed: true }])[0].set, { strokeColor: '#1971c2', strokeWidth: 2, dashed: true });
  assert.deepStrictEqual(V([{ op: 'style', id: 't1', strokeColor: '#e03131' }])[0].set, { color: '#e03131' });
  assert.deepStrictEqual(V([{ op: 'style', id: 'r1', strokeColor: 'javascript:1', fill: 'url(x)' }]), []);
});
t('embeds and app frames reject style and text', () => {
  assert.deepStrictEqual(V([{ op: 'style', id: 'e1', strokeColor: '#e03131' }, { op: 'style', id: 'app', fill: '#ffffff' }, { op: 'text', id: 'app', text: 'x' }, { op: 'text', id: 'e1', text: 'x' }, { op: 'style', id: 'i1', strokeColor: '#e03131' }]), []);
});
t('embeds and app frames may move, resize, delete', () => {
  const r = V([{ op: 'move', id: 'app', x: 1, y: 1 }, { op: 'resize', id: 'app', width: 300, height: 300 }, { op: 'delete', id: 'app' }]);
  assert.deepStrictEqual(r.map((o) => o.op), ['move', 'resize', 'delete']);
});
t('text clamps by type and refuses empty notes', () => {
  assert.strictEqual(V([{ op: 'text', id: 'n1', text: 'x'.repeat(900) }])[0].text.length, 400);
  assert.strictEqual(V([{ op: 'text', id: 't1', text: 'x'.repeat(3000) }])[0].text.length, 2000);
  assert.strictEqual(V([{ op: 'text', id: 'r1', text: 'x'.repeat(300) }])[0].text.length, 120);
  assert.strictEqual(V([{ op: 'text', id: 'n1', text: '' }]).length, 0);
  assert.strictEqual(V([{ op: 'text', id: 'r1', text: '' }]).length, 1);
  assert.strictEqual(V([{ op: 'text', id: 'n1', text: 5 }]).length, 0);
});
t('align / distribute / arrange / zone checks', () => {
  assert.strictEqual(V([{ op: 'align', ids: ['n1'], mode: 'left' }]).length, 0);
  assert.deepStrictEqual(V([{ op: 'align', ids: ['n1', 'n2', 'n2', 'nope'], mode: 'left' }])[0].ids, ['n1', 'n2']);
  assert.strictEqual(V([{ op: 'align', ids: ['n1', 'n2'], mode: 'diagonal' }]).length, 0);
  assert.strictEqual(V([{ op: 'distribute', ids: ['n1', 'n2'], axis: 'x' }]).length, 0);
  assert.strictEqual(V([{ op: 'distribute', ids: ['n1', 'n2', 'n3'], axis: 'x' }]).length, 1);
  assert.strictEqual(V([{ op: 'arrange', ids: ['n1', 'n2'], layout: 'grid', x: NaN, y: 0 }]).length, 0);
  assert.strictEqual(V([{ op: 'arrange', ids: ['n1', 'n2'], layout: 'grid', x: 8, y: 8 }])[0].gap, 24);
  assert.strictEqual(V([{ op: 'arrange', ids: ['n1', 'n2'], layout: 'row', x: 8, y: 8, gap: 9999 }])[0].gap, 200);
  assert.strictEqual(V([{ op: 'zone', ids: ['n1', 'r1', 'e1'], zone: 'r1' }])[0].ids.join(), 'n1');
  assert.strictEqual(V([{ op: 'zone', ids: ['n1'], zone: 'nope' }]).length, 0);
});
t('at most 40 ops', () => {
  const many = []; for (let i = 0; i < 100; i++) many.push({ op: 'move', id: 'n1', x: i, y: i });
  assert.strictEqual(V(many).length, 40);
});
t('at most 60 ids touched', () => {
  const items = {}, ids = []; for (let i = 0; i < 80; i++) { items['k' + i] = { type: 'note' }; ids.push('k' + i); }
  const c = Object.assign({}, ctx, { items });
  const ops = ids.map((id) => ({ op: 'move', id, x: 0, y: 0 }));
  assert.strictEqual(lib.validateEditOps(ops, c).ops.length, 40);
  const two = lib.validateEditOps([{ op: 'align', ids: ids.slice(0, 50), mode: 'left' }, { op: 'align', ids: ids.slice(40, 80), mode: 'top' }, { op: 'move', id: 'k3', x: 1, y: 1 }], c).ops;
  assert.deepStrictEqual(two.map((o) => o.op), ['align', 'move']);
});
t('delete guard', () => {
  assert(!lib.needsDeleteConfirm(5, 100));
  assert(lib.needsDeleteConfirm(6, 100));
  assert(!lib.needsDeleteConfirm(2, 4));
  assert(lib.needsDeleteConfirm(3, 5));
  const r = lib.validateEditOps([{ op: 'delete', id: 'n1' }, { op: 'delete', id: 'n1' }, { op: 'delete', id: 'n2' }], ctx);
  assert.deepStrictEqual(r.deletes, ['n1', 'n2']);
});

console.log(n + ' tests passed');
