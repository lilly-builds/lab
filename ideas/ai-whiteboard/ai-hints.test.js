/* node ideas/ai-whiteboard/ai-hints.test.js
   Typewriter hints (build plan 1.18): Lilly's prompts type out, hold, erase and cycle in the ask box's placeholder, and the hint code never
   writes what gets sent. Runs the HINTS-PURE block of app-07-modal.js; the click-to-stop behavior is checked in the browser run. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app-07-modal.js'), 'utf8');
const a = src.indexOf('/* HINTS-PURE-BEGIN'), b = src.indexOf('/* HINTS-PURE-END */');
const H = new Function(src.slice(a, b) + '\nreturn { HINTS: HINTS, hintAt: hintAt, T: HINT_TYPE, HOLD: HINT_HOLD, E: HINT_ERASE, GAP: HINT_GAP };')();

let n = 0;
const t = (name, fn) => { n++; fn(); console.log('ok  ' + name); };

t('three prompts, Lilly\'s first two word for word, each with a blank to fill', () => {
  assert.strictEqual(H.HINTS.length, 3);
  assert.strictEqual(H.HINTS[0], 'My biggest dream is ___. Help me make it real.');
  assert.strictEqual(H.HINTS[1], 'I have to do ___ today. Get it done so I can focus on building my dream.');
  assert.ok(H.HINTS.every((s) => s.includes('___')));
});
t('types a character at a time, holds the whole prompt, then erases it', () => {
  const s = H.HINTS[0];
  assert.strictEqual(H.hintAt(H.HINTS, 0), '');
  assert.strictEqual(H.hintAt(H.HINTS, H.T * 5), s.slice(0, 5));
  assert.strictEqual(H.hintAt(H.HINTS, s.length * H.T + 10), s);
  assert.strictEqual(H.hintAt(H.HINTS, s.length * H.T + H.HOLD + H.E * 10), s.slice(0, s.length - 10));
});
t('moves to the next prompt, and after the last comes back to the first', () => {
  const one = (s) => s.length * H.T + H.HOLD + s.length * H.E + H.GAP;
  const t2 = one(H.HINTS[0]);
  assert.strictEqual(H.hintAt(H.HINTS, t2 + H.T * 4), H.HINTS[1].slice(0, 4));
  const cycle = H.HINTS.reduce((s, p) => s + one(p), 0);
  assert.strictEqual(H.hintAt(H.HINTS, cycle + H.T * 3), H.HINTS[0].slice(0, 3));
});
t('the hint code only ever sets the placeholder, never the box\'s value (a hint is never sent)', () => {
  const start = src.indexOf('/* ---------- typewriter hints'), end = src.indexOf('/* ---------- connect modal');
  const block = src.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.ok(!/ask\.value\s*=[^=]/.test(block), 'no write to ask.value');
  assert.ok(/stopHints\)/.test(block) && /'pointerdown', stopHints/.test(block) && /'keydown', stopHints/.test(block), 'a click or a key stops it');
  assert.ok(/PROVIDER !== 'toolbox'/.test(block), 'only on the AI Magic Toolbox');
});
console.log('1..' + n);
console.log('ALL PASS');
