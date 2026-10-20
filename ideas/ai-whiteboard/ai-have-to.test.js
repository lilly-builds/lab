/* node ideas/ai-whiteboard/ai-have-to.test.js
   The Have-to loop (loop1.js) on the AI Magic Toolbox: a toolbox error is final (the server already made its second attempt), so the
   loop never asks again; a bad pass still asks for a new one; an own-key provider's network error still gets its one quiet retry.
   Runs the real file in a sandbox with a stand-in board and instant timers. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

const SRC = fs.readFileSync(path.join(__dirname, 'loop1.js'), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));

// One note in the Have to do circle; dragging it there runs the loop. answer(req) plays the AI.
async function drag(answer) {
  const on = {}, listen = (k) => (ev, fn) => { on[k + ':' + ev] = fn; };
  const note = { id: 'n1', type: 'note', x: 0, y: 0, w: 100, h: 100, text: 'call the plumber' };
  const els = [note], seen = { calls: 0, badKey: 0 };
  const H = {
    ta: { addEventListener: listen('ta') }, cv: { addEventListener: listen('cv') }, els: () => els, editingId: () => null,
    inDream: (x, which) => which === 'have to do', hasKey: () => true, needKey() {}, save() {}, draw() {}, snap() {},
    newId: () => 'a' + els.length, fitNote() {}, bbox: (e) => ({ x: e.x, y: e.y, w: e.w, h: e.h }), NOTE: 100,
    bubble() {}, bubbleBox: () => null, closeBubble() {}, badKey() { seen.badKey++; },
    complete: async (req) => { seen.calls++; return answer(req); }
  };
  const window = {};
  vm.runInNewContext(SRC, { window, setTimeout: (f) => { setImmediate(f); return 0; }, clearTimeout() {}, AbortController, Promise, String, Math, Error });
  window.Loop1.init(H);
  on['cv:pointerdown'](); note.x = 40; on['cv:pointerup']();
  for (let i = 0; i < 50; i++) await tick();
  seen.landed = els.slice(1).map((e) => e.text);
  return seen;
}
const fail = (o) => async () => { throw Object.assign(new Error(o.message || 'x'), o); };

(async () => {
  const tests = [
    ['a toolbox error is final: one ask, then the quiet snag note', async () => {
      const s = await drag(fail({ message: "The AI couldn't finish this twice in a row.", status: 502, final: true, kind: 'cut' }));
      assert.strictEqual(s.calls, 1, 'no second ask after the server already used both attempts');
      assert.strictEqual(s.landed.length, 1);
    }],
    ['a blocked to-do is not sent to the gate again', async () => {
      const s = await drag(fail({ message: "That ask can't run here.", status: 422, final: true, reason: 'blocked' }));
      assert.strictEqual(s.calls, 1);
    }],
    ['a one-off server hiccup (503) keeps its one quiet retry', async () => {
      let k = 0;
      const s = await drag(async () => { if (k++ === 0) throw Object.assign(new Error('The AI service hit a snag.'), { status: 503, final: true, reason: 'server' }); return 'Call the plumber at 9.'; });
      assert.strictEqual(s.calls, 2);
      assert.deepStrictEqual(s.landed, ['Call the plumber at 9.']);
    }],
    ['any server hiccup keeps its retry, whatever the status (a 500 from the door, a 502 gateway page)', async () => {
      for (const status of [500, 502]) {
        let k = 0;
        const s = await drag(async () => { if (k++ === 0) throw Object.assign(new Error('snag'), { status, final: true, reason: 'server' }); return 'Done.'; });
        assert.strictEqual(s.calls, 2, 'status ' + status);
      }
    }],
    ['a bad pass asks for a new one, with no retry', async () => {
      const s = await drag(fail({ status: 401, final: true }));
      assert.deepStrictEqual([s.calls, s.badKey, s.landed.length], [1, 1, 0]);
    }],
    ['an own-key provider\'s network error keeps its one quiet retry', async () => {
      let k = 0;
      const s = await drag(async () => { if (k++ === 0) throw new TypeError('Failed to fetch'); return 'Call Joe at 9.'; });
      assert.strictEqual(s.calls, 2);
      assert.deepStrictEqual(s.landed, ['Call Joe at 9.']);
    }],
    ['the to-do goes out as the todo job with the note as the ask', async () => {
      let req = null;
      await drag(async (r) => { req = r; return 'ok'; });
      assert.deepStrictEqual([req.job, req.ask], ['todo', 'call the plumber']);
    }]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
