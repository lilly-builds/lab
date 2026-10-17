/* node ideas/ai-whiteboard/app-helpers.test.js
   Runs the APP-PURE block of app-02-state.js. cleanReply needs no DOM; the sanitizer tests need
   jsdom or linkedom (npm i jsdom) and are skipped with a notice when neither is installed. */
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, 'app-02-state.js'), 'utf8');
const m = src.match(/\/\* APP-PURE-BEGIN[^\n]*\n([\s\S]*?)\/\* APP-PURE-END \*\//);
assert(m, 'APP-PURE block not found');
const csp = src.match(/var APP_CSP = "([^"]*)"/)[1];
const lib = new Function('APP_MAX_CHARS', 'APP_CSP', m[1] + '; return { cleanReply, sanitizeApp };')(200000, csp);

const pad = '<p>' + 'x'.repeat(320) + '</p>';
const doc = (body, head) => '<!doctype html><html><head><title>T</title>' + (head || '') + '</head><body>' + body + pad + '</body></html>';
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

t('plain document passes', () => assert(lib.cleanReply(doc('<b>a</b>'))));
t('fences are stripped', () => assert.strictEqual(lib.cleanReply('```html\n' + doc('') + '\n```').slice(0, 9), '<!doctype'));
t('bare fence without language', () => assert(lib.cleanReply('```\n' + doc('') + '\n```')));
t('<html start accepted, case-insensitive', () => assert(lib.cleanReply('<HTML><body>' + 'y'.repeat(400) + '</BODY></HTML>')));
t('prose before the document rejected', () => assert.strictEqual(lib.cleanReply('Here you go:\n' + doc('')), null));
t('missing </html> (truncated) rejected', () => assert.strictEqual(lib.cleanReply(doc('').replace('</html>', '')), null));
t('too short rejected', () => assert.strictEqual(lib.cleanReply('<!doctype html><html></html>'), null));
t('too long rejected', () => assert.strictEqual(lib.cleanReply(doc('z'.repeat(200000))), null));
t('non-string rejected', () => assert.strictEqual(lib.cleanReply(null), null));

let Parser = null;
try { Parser = new (require('jsdom').JSDOM)('').window.DOMParser; } catch (e) {}
if (!Parser) { try { Parser = new (require('linkedom').DOMParser)().constructor; } catch (e) {} }
if (!Parser) console.log('skip sanitizer tests: install jsdom or linkedom to run them');
else {
  const run = (html) => lib.sanitizeApp(html, Parser);
  const dirty = doc(
    '<iframe src="https://evil.test"></iframe><object data="x"></object><embed src="x"><frame src="x">' +
    '<img src="https://evil.test/a.png"><img src="data:image/gif;base64,R0lGOD"><a href="//evil.test">a</a><a href="#top">b</a>' +
    '<script src="https://evil.test/x.js"></script><script>var ok = 1;</script><form action="https://evil.test"></form>',
    '<meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test/">' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Special+Elite">' +
    '<link rel="stylesheet" href="https://evil.test/a.css"><link rel="icon" href="https://evil.test/i.png">');
  const out = run(dirty), d = new Parser().parseFromString(out.html, 'text/html');
  t('doctype in front', () => assert(out.html.startsWith('<!doctype html>')));
  t('title read', () => assert.strictEqual(out.title, 'T'));
  t('CSP meta is first child of head with the exact policy', () => {
    const f = d.head.firstElementChild;
    assert.strictEqual(f.tagName, 'META'); assert.strictEqual(f.getAttribute('http-equiv'), 'Content-Security-Policy');
    assert.strictEqual(f.getAttribute('content'), csp);
  });
  t('only the CSP meta[http-equiv] remains', () => assert.strictEqual(d.querySelectorAll('meta[http-equiv]').length, 1));
  t('iframe, object, embed, frame, base removed', () => assert.strictEqual(d.querySelectorAll('iframe, object, embed, frame, base').length, 0));
  t('only the Google Fonts link remains', () => {
    const l = d.querySelectorAll('link'); assert.strictEqual(l.length, 1); assert(l[0].href.startsWith('https://fonts.googleapis.com/'));
  });
  t('remote script[src] removed, inline script kept', () => {
    assert.strictEqual(d.querySelectorAll('script[src]').length, 0); assert(out.html.includes('var ok = 1;'));
  });
  t('remote src/href/action attributes dropped, data: and #hash kept', () => {
    assert.strictEqual(d.querySelectorAll('[src^="http"], :not(link)[href^="http"], [href^="//"], [action^="http"]').length, 0);
    assert(d.querySelector('img[src^="data:"]')); assert(d.querySelector('a[href="#top"]'));
  });
  t('template contents are scrubbed too', () => {
    const o = run(doc('<template><iframe src="https://evil.test"></iframe><img src="https://evil.test/a.png"></template>'));
    assert(!/evil\.test/.test(o.html));
  });
}
console.log(n + ' passed');
