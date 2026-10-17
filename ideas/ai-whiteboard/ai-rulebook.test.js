/* node ideas/ai-whiteboard/ai-rulebook.test.js
   Rulebook: table-driven picks, allowlist only, placeholder guard, picture rule, budgets. No AI calls. */
const assert = require('assert');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const rb = await import('./supabase/functions/_shared/rulebook.mjs');
  const ok = { AI_ALLOW_PLACEHOLDERS: '1' };
  const ids = new Set(rb.ALLOWLIST.models.map((m) => m.id));
  const byId = (id) => rb.ALLOWLIST.models.find((m) => m.id === id);

  const tests = [
    ['placeholder list is refused without the switch', () => assert.throws(() => rb.pick('draw', {}, {}, 'p', {}), /placeholder/)],
    ['placeholder list is allowed with the switch', () => assert.ok(rb.pick('draw', {}, {}, 'p', ok).models.length)],
    ['every job returns only allowlist models', () => {
      for (const job of Object.keys(rb.ROWS)) rb.pick(job, {}, {}, 'p', ok).models.forEach((m) => assert.ok(ids.has(m), job + ' ' + m));
    }],
    ['picture payload excludes text-only models', () => {
      for (const job of Object.keys(rb.ROWS)) rb.pick(job, {}, { hasImage: true }, 'p', ok).models.forEach((m) => assert.ok(byId(m).image, job + ' ' + m));
    }],
    ['unknown job throws', () => assert.throws(() => rb.pick('hack', {}, {}, 'p', ok), /unknown job/)],
    ['maxPrice is always set', () => {
      for (const job of Object.keys(rb.ROWS)) { const p = rb.pick(job, {}, {}, 'p', ok); assert.ok(p.maxPrice.prompt > 0 && p.maxPrice.completion > 0); }
    }],
    ['build keeps a 9000-token answer and thinking is on top', () => {
      const p = rb.pick('build', {}, {}, 'p', ok);
      assert.strictEqual(p.answerBudget, 9000); assert.ok(p.thinkingBudget > 0);
    }],
    ['hard draw moves to frontier, easy draw stays open', () => {
      assert.strictEqual(byId(rb.pick('draw', { difficulty: 'hard' }, {}, 'p', ok).models[0]).tier, 'frontier');
      assert.strictEqual(byId(rb.pick('draw', { difficulty: 'easy' }, {}, 'p', ok).models[0]).tier, 'open');
    }],
    ['fixed rows ignore difficulty', () => {
      assert.strictEqual(byId(rb.pick('gate', { difficulty: 'hard' }, {}, 'p', ok).models[0]).tier, 'open');
    }],
    ['an avoided model is dropped, unless that would leave no model at all', () => {
      const all = rb.pick('draw', {}, {}, 'p', ok).models;
      const fewer = rb.pick('draw', {}, {}, 'p', ok, [all[0]]).models;
      assert.ok(!fewer.includes(all[0]) && fewer.length >= 1, 'the next healthy model takes the slot');
      assert.deepStrictEqual(rb.pick('draw', {}, {}, 'p', ok, [...ids]).models, all, 'every model avoided: the normal pick stands');
    }],
    ['Dream plan and the have-to loop keep the browser\'s answer lengths, with no thinking', () => {
      assert.deepStrictEqual([rb.ROWS.plan.answerBudget, rb.ROWS.plan.thinkingBudget], [400, 0]);
      assert.deepStrictEqual([rb.ROWS.todo.answerBudget, rb.ROWS.todo.thinkingBudget], [300, 0]);
    }],
    ['worst case cost is an upper bound of any in-budget call', () => {
      for (const job of Object.keys(rb.ROWS)) {
        const p = rb.pick(job, {}, {}, 'p', ok);
        const worst = rb.worstCaseCost(p, 10000);
        const mostPossible = (10000 * p.maxPrice.prompt + (p.answerBudget + p.thinkingBudget) * p.maxPrice.completion) / 1e6;
        assert.ok(worst >= mostPossible - 1e-12 && worst > 0, job);
      }
    }]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
