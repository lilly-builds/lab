/* node ideas/ai-whiteboard/test-isimageurl.js : runs isImageUrl exactly as it appears in app-11-embeds.js */
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, 'app-11-embeds.js'), 'utf8');
const m = /\/\* isImageUrl:start \*\/([\s\S]*?)\/\* isImageUrl:end \*\//.exec(src);
assert(m, 'isImageUrl block not found');
const isImageUrl = new Function(m[1] + '; return isImageUrl;')();

const cases = [
  ['https://i.pinimg.com/736x/ab/cd/ef/abcdef.jpg', true],
  ['https://example.com/photo.PNG', true],
  ['https://example.com/a/b.jpeg?w=200#top', true],
  ['https://example.com/anim.gif', true],
  ['https://example.com/pic.webp?x=1', true],
  ['https://example.com/pic.avif', true],
  ['https://example.com/logo.svg', true],
  ['https://i.pinimg.com/originals/abc', true],
  ['https://assets.pinterest.com/x', true],
  ['https://images.unsplash.com/photo-123?w=800', true],
  ['https://i.imgur.com/AbC123', true],
  ['https://upload.wikimedia.org/wikipedia/commons/a/a9/x', true],
  ['https://pbs.twimg.com/media/abc', true],
  ['https://cdn.i.pinimg.com/abc', true],
  ['https://example.com/image?format=jpg&name=large', true],
  ['https://example.com/image?format=webp', true],
  ['http://example.com/photo.jpg', false],
  ['https://i.pinimg.com.evil.com/photo', false],
  ['https://evili.pinimg.com/photo', false],
  ['https://evil.com/i.pinimg.com/x', false],
  ['https://evil.com/?u=https://i.pinimg.com/a.jpg', false],
  ['https://example.com/page?file=a.png', false],
  ['https://example.com/page#a.png', false],
  ['https://example.com/photo.jpg/', false],
  ['https://example.com/photo.jpgx', false],
  ['https://example.com/?format=gif', false],
  ['https://www.pinterest.com/pin/123/', false],
  ['https://www.youtube.com/watch?v=abcdefghijk', false],
  ['javascript:alert(1)//.png', false],
  ['data:image/png;base64,AAAA', false],
  ['not a url', false],
  ['', false],
  [null, false],
  [undefined, false]
];
let bad = 0;
cases.forEach(([u, want]) => {
  const got = isImageUrl(u);
  if (got !== want) { bad++; console.log('FAIL', JSON.stringify(u), 'want', want, 'got', got); }
});
console.log(cases.length - bad + '/' + cases.length + ' passed');
process.exit(bad ? 1 : 0);
