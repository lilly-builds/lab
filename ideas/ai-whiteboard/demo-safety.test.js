/* node ideas/ai-whiteboard/demo-safety.test.js
   U10 static gates: the demo-safe promises that cannot regress silently.
   Behavioral AE1/AE6 (zero backend calls flag-off; fail-open timing) are in
   sync.test.js; this file guards the wiring those tests depend on. */
const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const cfg = fs.readFileSync(__dirname + '/supabase-config.js', 'utf8');
const syncjs = fs.readFileSync(__dirname + '/sync.js', 'utf8');

let n = 0;
const t = (name, cond) => { n++; assert(cond, name); console.log('ok  ' + name); };

t('committed config defaults to enabled:false (flag-off is the shipped default)', /enabled:\s*false/.test(cfg));
t('config carries no service-role key', !/service_role|service-key/i.test(cfg));

const order = ['loop1.js', 'supabase-config.js', 'sync-engine.js', 'sync.js', 'auth.js', 'team.js', 'templates.js'];
let at = -1;
order.forEach((tag) => {
  const i = html.indexOf('src="' + tag + '"');
  assert(i > at, 'script order: ' + tag + ' loads after the app scripts');
  at = i;
});
console.log('ok  sync scripts load after the app, before the inline script');
n++;
t('the inline script follows the sync tags', html.indexOf('src="sync.js"') < html.indexOf('window.AIWB'));
t('AIWB surface exists with null hooks (no sync until sync.js fills them)', /window\.AIWB\s*=\s*\{[\s\S]*?afterSave:\s*null,\s*newId:\s*null,\s*adoptBoard:\s*null/.test(html));
t('save() calls the afterSave hook, wrapped so sync can never break save', /function save\(\) \{ lsSet\(KEY_SCENE, ser\(els\)\); if \(window\.AIWB && AIWB\.afterSave\) \{ try \{ AIWB\.afterSave\(\); \} catch \(e\) \{\} \} \}/.test(html));
t('supabase-js loads lazily from the CDN, never top-level', !/^\s*import\s/m.test(syncjs) && syncjs.indexOf('import(CDN)') > 0 && syncjs.indexOf('loadSupabase') > 0);
t('the kill switch ?sync=off is honored first in flag resolution', syncjs.indexOf("q.get('sync') === 'off'") < syncjs.indexOf("q.get('sync') === 'on'"));

console.log('1..' + n);
console.log('ALL PASS');
