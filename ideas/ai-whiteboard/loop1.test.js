/* node ideas/ai-whiteboard/loop1.test.js */
const assert = require('assert'), L = require('./loop1.js');
const inC = (where) => (n, label) => label === where;
const note = (o) => Object.assign({ type: 'note', text: 'candle wax in carpet?' }, o);
assert(L.qualifies(note(), inC('have to do')));
assert(!L.qualifies(note(), inC('dream')));
assert(!L.qualifies(note(), inC('want to do')));
assert(!L.qualifies(note({ loop1Asked: true }), inC('have to do')));
assert(!L.qualifies(note({ text: '  ' }), inC('have to do')));
assert.strictEqual(L.cleanAnswer('```\n**Iron** it\n```'), 'Iron it');
assert(L.cleanAnswer('word '.repeat(200)).length <= 425);
assert.strictEqual(L.cleanAnswer(null), '');
console.log('ok');
