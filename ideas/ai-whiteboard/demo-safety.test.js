/* node ideas/ai-whiteboard/demo-safety.test.js
   U10 static gates: the demo-safe promises that cannot regress silently.
   Behavioral AE1/AE6 (zero backend calls flag-off; fail-open timing) are in
   sync.test.js; this file guards the wiring those tests depend on. */
const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const boot = fs.readFileSync(__dirname + '/app-15-boot.js', 'utf8');
const state = fs.readFileSync(__dirname + '/app-02-state.js', 'utf8');
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
t('the app scripts follow the sync tags', html.indexOf('src="sync.js"') < html.indexOf('src="app-01-providers.js"') && html.indexOf('src="app-15-boot.js"') > html.indexOf('src="sync.js"'));
t('AIWB surface exists with null hooks (no sync until sync.js fills them)', /window\.AIWB\s*=\s*\{[\s\S]*?afterSave:\s*null,\s*newId:\s*null,\s*adoptBoard:\s*null/.test(boot));
t('save() calls the afterSave hook, wrapped so sync can never break save', /function save\(\) \{ lsSet\(KEY_SCENE, ser\(els\)\); if \(window\.AIWB && AIWB\.afterSave\) \{ try \{ AIWB\.afterSave\(\); \} catch \(e\) \{\} \} \}/.test(state));
t('supabase-js loads lazily from the CDN, never top-level', !/^\s*import\s/m.test(syncjs) && syncjs.indexOf('import(CDN)') > 0 && syncjs.indexOf('loadSupabase') > 0);
t('the kill switch ?sync=off is honored first in flag resolution', syncjs.indexOf("q.get('sync') === 'off'") < syncjs.indexOf("q.get('sync') === 'on'"));

/* manifest guard: the app is fifteen classic scripts that share one global scope, so the tag list is the program */
const path = require('path');
const appTags = [];
html.replace(/<script src="(app-(\d\d)-[a-z0-9-]+\.js)"><\/script>/g, (m, file, nn) => { appTags.push({ file, nn: Number(nn), at: html.indexOf(m) }); return m; });
t('manifest: fifteen app-NN tags in ascending order 01..15', appTags.length === 15 && appTags.every((a, i) => a.nn === i + 1));
t('manifest: the app tags come after note-resize.js', appTags.every((a) => a.at > html.indexOf('src="note-resize.js"')));
const between = html.slice(appTags[0].at, appTags[14].at);
t('manifest: the app tags are contiguous (nothing between them)', between.split('\n').every((line) => /^<script src="app-\d\d-[a-z0-9-]+\.js"><\/script>$/.test(line) || line === ''));
t('manifest: every app tag resolves to a file on disk', appTags.every((a) => fs.existsSync(path.join(__dirname, a.file))));
t('manifest: no inline script (a script tag without src) remains in index.html', !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html));
const preloads = [];
html.replace(/<link rel="preload" as="script" href="(app-[^"]+\.js)">/g, (m, h) => { preloads.push(h); return m; });
t('manifest: preload hints match the app tags one-to-one', preloads.length === appTags.length && preloads.every((h, i) => h === appTags[i].file));

const reserved = ['opener', 'top', 'parent', 'self', 'name', 'status', 'event', 'length', 'closed', 'frames', 'history', 'location', 'screen', 'origin', 'scroll', 'stop', 'find', 'print', 'open', 'close', 'focus', 'blur'];
const clashes = [];
appTags.forEach((a) => {
  fs.readFileSync(path.join(__dirname, a.file), 'utf8').split('\n').forEach((line) => {
    const m = /^ {2}(var|function|async function) ([A-Za-z_$][\w$]*)/.exec(line);
    if (!m) return;
    const names = [m[2]];
    if (m[1] === 'var') line.replace(/, ([A-Za-z_$][\w$]*)\s*(?==|,|;|$)/g, (x, nm) => { names.push(nm); return x; });
    names.forEach((nm) => { if (reserved.indexOf(nm) >= 0) clashes.push(a.file + ':' + nm); });
  });
});
t('manifest: no top-level declaration shadows a window-reserved name (' + clashes.join(',') + ')', clashes.length === 0);

console.log('1..' + n);
console.log('ALL PASS');
