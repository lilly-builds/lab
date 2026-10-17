/* node ideas/ai-whiteboard/note-resize.test.js
   Sticky-note corner resize: sizing rules, hit area, simulated drag, cancel and pinch,
   save round-trip, and the four index.html wiring points. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const NR = require('./note-resize.js');

let n = 0, failures = 0;
const t = (name, fn) => {
  n++;
  try { fn(); console.log('ok  ' + name); } catch (e) { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
};

const toScreen = (x, y) => ({ x: x, y: y });
const note = (o) => Object.assign({ id: 'n1', type: 'note', x: 100, y: 100, w: 120, h: 120, text: 'hi', fill: '#ffec99' }, o);

t('min 100, max 360, width and height independent', () => {
  assert.deepStrictEqual(NR.nextSize(120, 120, -500, 40), { w: 100, h: 160 });
  assert.deepStrictEqual(NR.nextSize(120, 120, 900, -5), { w: 360, h: 115 });
  assert.strictEqual(NR.MIN, 100); assert.strictEqual(NR.MAX, 360);
});
t('sizes are whole numbers', () => {
  const s = NR.nextSize(120, 120, 10.6, 3.2);
  assert.strictEqual(s.w, 131); assert.strictEqual(s.h, 123);
});
t('a note outside the range does not jump when grabbed', () => {
  assert.deepStrictEqual(NR.nextSize(80, 400, 0, 0), { w: 80, h: 400 });
  assert.deepStrictEqual(NR.nextSize(80, 400, 10, -10), { w: 90, h: 390 });
  assert.deepStrictEqual(NR.nextSize(80, 400, -30, 50), { w: 80, h: 400 });
});
t('hit area is 28px square around the bottom-right corner', () => {
  const el = note();
  assert.ok(NR.hitCorner(el, toScreen, 220, 220));
  assert.ok(NR.hitCorner(el, toScreen, 234, 206));
  assert.ok(!NR.hitCorner(el, toScreen, 235, 220));
  assert.ok(!NR.hitCorner(el, toScreen, 220, 235));
  assert.ok(!NR.hitCorner({ type: 'rect', x: 0, y: 0, w: 50, h: 50 }, toScreen, 50, 50));
});
t('hit area stays 28px on screen at any zoom', () => {
  const z = 4, ts = (x, y) => ({ x: x * z, y: y * z });
  assert.ok(NR.hitCorner(note(), ts, 220 * z + 14, 220 * z));
  assert.ok(!NR.hitCorner(note(), ts, 220 * z + 15, 220 * z));
});

/* a tiny window + canvas that dispatches in capture-then-target order */
function rig(el, opts) {
  opts = opts || {};
  const lis = { pointerdown: [], pointermove: [], pointerup: [], pointercancel: [] };
  const win = { addEventListener: (ev, fn, cap) => lis[ev].push({ fn, cap: !!cap }) };
  const cv = { setPointerCapture() {}, releasePointerCapture() {} };
  const st = { undo: [], saves: 0, draws: 0, mainSaw: 0, el, tool: 'move', editing: false };
  NR.init({
    win, cv, getSel: () => el, getView: () => ({ z: 1 }), toScreen,
    canResize: () => st.tool === 'move' && !st.editing,
    snap: () => st.undo.push(JSON.stringify(el)), popUndo: () => st.undo.pop(), save: () => { st.saves++; }, draw: () => { st.draws++; }
  });
  st.fire = (ev, e) => {
    e = Object.assign({ target: cv, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0, stopped: false }, e);
    e.stopPropagation = () => { e.stopped = true; }; e.preventDefault = () => {};
    lis[ev].filter((l) => l.cap).forEach((l) => l.fn(e));
    if (!e.stopped) st.mainSaw++;
    lis[ev].filter((l) => !l.cap).forEach((l) => l.fn(e));
    return e;
  };
  st.cv = cv;
  return st;
}

t('simulated drag resizes live, flags sized, one undo step, saves', () => {
  const el = note(), r = rig(el);
  const d = r.fire('pointerdown', { clientX: 220, clientY: 220 });
  assert.ok(d.stopped, 'corner press never reaches move / tap-to-edit');
  r.fire('pointermove', { clientX: 260, clientY: 300 });
  assert.strictEqual(el.w, 160); assert.strictEqual(el.h, 200); assert.strictEqual(el.sized, true);
  r.fire('pointerup', { clientX: 260, clientY: 300 });
  assert.strictEqual(el.w, 160); assert.strictEqual(r.undo.length, 1); assert.strictEqual(r.saves, 1);
});
t('a tap without drag changes nothing and leaves undo alone', () => {
  const el = note(), r = rig(el);
  r.fire('pointerdown', { clientX: 220, clientY: 220 });
  r.fire('pointerup', { clientX: 220, clientY: 220 });
  assert.strictEqual(el.w, 120); assert.ok(!('sized' in el)); assert.strictEqual(r.undo.length, 0); assert.strictEqual(r.saves, 0);
});
t('a press away from the corner is left to the app', () => {
  const el = note(), r = rig(el);
  const d = r.fire('pointerdown', { clientX: 150, clientY: 150 });
  assert.ok(!d.stopped); assert.strictEqual(r.undo.length, 0);
});
t('no resize while editing or in another tool', () => {
  const el = note(), r = rig(el);
  r.editing = true; r.editing = true;
  const a = r.fire('pointerdown', { clientX: 220, clientY: 220 });
  r.fire('pointerup', {});
  r.editing = false; r.tool = 'pen';
  const b = r.fire('pointerdown', { clientX: 220, clientY: 220 });
  assert.ok(!b.stopped); assert.ok(a);
});
t('pointercancel restores the old size and removes the undo entry', () => {
  const el = note({ sized: true, w: 150 }), r = rig(el);
  r.fire('pointerdown', { clientX: 250, clientY: 220 });
  r.fire('pointermove', { clientX: 300, clientY: 300 });
  assert.notStrictEqual(el.w, 150);
  r.fire('pointercancel', {});
  assert.strictEqual(el.w, 150); assert.strictEqual(el.h, 120); assert.strictEqual(el.sized, true);
  assert.strictEqual(r.undo.length, 0); assert.strictEqual(r.saves, 0);
});
t('a second finger restores the old size and removes the undo entry', () => {
  const el = note(), r = rig(el);
  r.fire('pointerdown', { clientX: 220, clientY: 220 });
  r.fire('pointermove', { clientX: 280, clientY: 280 });
  r.fire('pointerdown', { pointerId: 2, isPrimary: false, clientX: 10, clientY: 10 });
  assert.strictEqual(el.w, 120); assert.ok(!('sized' in el)); assert.strictEqual(r.undo.length, 0);
});

t('save round-trip keeps w, h and sized as whole numbers; old notes have no flag', () => {
  const el = note({ w: 161, h: 203, sized: true });
  const back = JSON.parse(JSON.stringify([el, note({ id: 'n2' })]));
  assert.deepStrictEqual([back[0].w, back[0].h, back[0].sized], [161, 203, true]);
  assert.ok(!('sized' in back[1])); assert.strictEqual(back[1].w, 120);
});

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const render = fs.readFileSync(path.join(__dirname, 'app-03-render.js'), 'utf8');
const pointer = fs.readFileSync(path.join(__dirname, 'app-05-pointer.js'), 'utf8');
t('wiring: script tag, paint, init hook, fitNote early return (index.html + app modules)', () => {
  assert.ok(html.includes('<script src="note-resize.js"></script>'));
  assert.ok(html.indexOf('note-resize.js') < html.indexOf('src="app-05-pointer.js"'), 'module loads before the app scripts');
  assert.ok(/NoteResize\.paint\(g, el, toScreen\)/.test(render));
  assert.ok(/NoteResize\.init\(\{/.test(pointer));
  assert.ok(/function fitNote\(el\) \{\n\s+if \(el\.sized\) return;/.test(render));
});

console.log('\n' + (n - failures) + '/' + n + ' passed');
if (failures) process.exit(1);
