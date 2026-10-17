/* node ideas/ai-whiteboard/ai-billing.test.js
   The hold's input estimate must never be smaller than what a model can bill (invariant I1). Models tokenize at the byte
   level, so a token covers at least one UTF-8 byte: bytes are a safe upper bound in any language. Pictures are a flat cap. */
const assert = require('assert');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const b = await import('./supabase/functions/_shared/billing.mjs');
  const bytes = (s) => Buffer.byteLength(s, 'utf8');

  const tests = [
    ['English, Chinese, emoji and board JSON: the estimate is at least the UTF-8 byte count', () => {
      for (const s of ['plan a bakery', '帮我计划一家面包店，要有咖啡和甜点', '🎂🧁🍰✨🎉'.repeat(20), JSON.stringify([{ id: 'e1', type: 'note', text: '日本語のメモ' }])]) {
        assert.ok(b.estTokens(s) >= bytes(s), s.slice(0, 12) + ': ' + b.estTokens(s) + ' < ' + bytes(s));
      }
    }],
    ['several texts add up, with a little room per message', () => {
      assert.ok(b.estTokens('abc', 'def') >= 6);
      assert.strictEqual(b.estTokens(), 0);
    }],
    ['message tokens count every text part and a flat cap per picture', () => {
      const msgs = [
        { role: 'system', content: 'rules' },
        { role: 'user', content: [{ type: 'text', text: '面包店' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }
      ];
      assert.ok(b.messageTokens(msgs) >= bytes('rules') + bytes('面包店') + b.IMAGE_TOKENS);
      assert.ok(b.messageTokens([{ role: 'user', content: 'x' }]) < b.IMAGE_TOKENS);
    }]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
