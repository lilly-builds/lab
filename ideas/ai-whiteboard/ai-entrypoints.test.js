/* node ideas/ai-whiteboard/ai-entrypoints.test.js
   Invariant I8 (build plan 1.15): every AI entry point on the board reaches the AI only through /route then /run on the AI Magic Toolbox.
   The toolbox refuses any call that names no job and carries no ticket (ai-client.test.js), so this test finds every provider call in
   the board's code and fails if one names neither: a new side feature cannot slip past the safety gate unnoticed. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter((f) => /^app-\d\d-.*\.js$/.test(f) || f === 'loop1.js');
let n = 0;
const t = (name, fn) => { n++; fn(); console.log('ok  ' + name); };

// The text between a call's parentheses, by bracket counting (strings in these call sites hold no stray brackets).
function argsAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return '';
}
// An identifier argument (for example `req`) is checked through the object literal it was assigned.
function literalFor(src, name, before) {
  const head = src.lastIndexOf('var ' + name + ' = {', before);
  if (head < 0) return '';
  return argsAt(src.replace(/\{/g, '(').replace(/\}/g, ')'), head + ('var ' + name + ' = ').length);
}

const sites = [];
for (const f of files) {
  if (f === 'app-01-providers.js') continue; // the providers themselves: definitions, not entry points
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  const re = /\.(complete|stream)\(/g;
  let m;
  while ((m = re.exec(src))) {
    let args = argsAt(src, m.index + m[0].length - 1);
    if (!args.trim()) continue; // Blob.stream() and the like take no request: not an AI call
    const id = /^\s*([A-Za-z_$][\w$]*)\s*[,)]?/.exec(args);
    if (id && !/[{:]/.test(args.split(',')[0])) args = literalFor(src, id[1], m.index) + args;
    sites.push({ file: f, line: src.slice(0, m.index).split('\n').length, args });
  }
}

t('found the known entry points (ask box draw and edit, app build, Dream plan, have-to loop, its hook)', () => {
  const where = sites.map((s) => s.file);
  for (const f of ['app-09-route.js', 'app-12-built-apps.js', 'app-14-loops.js', 'app-15-boot.js', 'loop1.js']) assert.ok(where.includes(f), f);
  assert.ok(sites.length >= 7, 'sites: ' + sites.length);
});
t('every provider call on the board names its job (or forwards it)', () => {
  const bad = sites.filter((s) => !/\bjob:/.test(s.args));
  assert.deepStrictEqual(bad.map((s) => s.file + ':' + s.line), []);
});
t('the ask box hands its route ticket to the handlers it runs', () => {
  const route = fs.readFileSync(path.join(__dirname, 'app-09-route.js'), 'utf8');
  assert.ok(/ticket: i === 0 \? plan\.ticket : null/.test(route));
  assert.ok(/ticket: c\.ticket/.test(route));
});
t('no board file talks to an AI provider directly except the provider table', () => {
  for (const f of files.filter((x) => x !== 'app-01-providers.js')) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(!/api\.anthropic\.com|api\.openai\.com|openrouter\.ai/.test(src), f);
  }
});
console.log('1..' + n);
console.log('ALL PASS');
