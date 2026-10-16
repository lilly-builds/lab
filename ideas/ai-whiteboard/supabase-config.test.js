/* node ideas/ai-whiteboard/supabase-config.test.js
   U1 gate: the committed sync config must default off and carry no secret key. */
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, 'supabase-config.js'), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

const sandbox = { window: {} };
new Function('window', src)(sandbox.window);
const cfg = sandbox.window.AIWB_SUPABASE;

t('config object exists', () => assert(cfg && typeof cfg === 'object'));
t('sync defaults off', () => assert.strictEqual(cfg.enabled, false));
t('board room has its own gate, on, independent of sync', () => assert.strictEqual(cfg.templatesEnabled, true));
t('no secret key in committed values', () => {
  const values = Object.values(cfg).join(' ');
  assert(!/service[_-]?role/i.test(values), 'service-role key in config values');
  assert(!/eyJ[A-Za-z0-9_-]{20,}/.test(values), 'looks like a real JWT is committed');
});
t('url is a placeholder or a real supabase host', () => {
  assert(cfg.url.includes('YOUR-PROJECT-REF') || /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(cfg.url));
});
console.log('1..' + n);
