// THIS FILE IS FOR: the fake model behind the local dev server and the end-to-end tests. It answers each job with a reply in the shape
// the board expects, so the whole path can be clicked through with no real AI account. Never used by product code.
import { IDEAMAP_RULE, DREAM_SYSTEM, TODO_SYSTEM, NEXTMOVES_SYSTEM, SYSTEM_EDIT, SYSTEM_APP } from '../supabase/functions/_shared/prompts.mjs';

const textOf = (content) => (typeof content === 'string' ? content : (content.find((p) => p.type === 'text') || {}).text || '');
function boardOf(user) {
  const i = user.indexOf('Board JSON:\n');
  if (i < 0) return null;
  try { return JSON.parse(user.slice(i + 12)); } catch (e) { return null; }
}
const askOf = (user) => user.split('\n\nBoard JSON:\n')[0];

// The biggest free rectangle the board reported, or the visible area.
function room(board) {
  const f = board && Array.isArray(board.free) && board.free[0];
  if (f) return f;
  const v = (board && board.view) || { x: 0, y: 0, width: 1200, height: 800 };
  return { x: v.x + 40, y: v.y + 40, width: v.width - 80, height: v.height - 80 };
}

// THIS SECTION IS FOR: what a call costs on the fake: about 4 bytes a token, a picture as 1000 tokens, at half the request's
// max_price. Always under the server's hold, as on a real provider that honors max_price; rounded to the ledger's millionths.
export function realisticCost(body) {
  const mp = (body.provider && body.provider.max_price) || { prompt: 1, completion: 3 };
  let prompt = 0;
  for (const m of body.messages) {
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    for (const p of parts) prompt += p.type === 'text' ? Buffer.byteLength(p.text) / 4 : 1000;
  }
  const completion = Buffer.byteLength(respond(body)) / 4;
  return Math.max(1, Math.round((prompt * mp.prompt + completion * mp.completion) * 0.5)) / 1e6;
}

// THIS SECTION IS FOR: one reply per job. body is the OpenRouter request the server sent.
export function respond(body) {
  const sys = String(body.messages[0].content);
  const user = textOf(body.messages[body.messages.length - 1].content);
  if (/safety check/.test(sys)) return /BLOCK-ME/.test(user) ? '{"ok":false}' : '{"ok":true}';
  if (/route requests/.test(sys)) {
    const req = (JSON.parse(user).request || '').toLowerCase();
    const route = /\b(build|app|calculator|game|tool)\b/.test(req) ? 'build' : /\b(move|align|recolor|delete|tidy|rename)\b/.test(req) ? 'edit' : 'draw';
    return JSON.stringify({ route, confidence: 0.9, difficulty: 'normal' });
  }
  if (sys.startsWith(DREAM_SYSTEM)) return JSON.stringify({ goal: 'Open a small corner bakery', milestones: ['Write the menu', 'Find a space', 'Bake a test batch'], firstAction: 'List five favorite pastries' });
  if (sys.startsWith(TODO_SYSTEM)) return 'Start with the smallest piece: set a 10 minute timer and do just the first step.';
  if (sys.startsWith(NEXTMOVES_SYSTEM)) return JSON.stringify({ next: ['Add a dark mode', 'Save the last result'] });
  if (sys.startsWith(SYSTEM_APP)) return '<!doctype html><html><head><title>Tip calculator</title></head><body><h1>Tip calculator</h1><p>It works.</p></body></html>';
  if (sys.startsWith(SYSTEM_EDIT)) return JSON.stringify({ say: 'Tidied up.', ops: [] });
  const board = boardOf(user), r = room(board), ask = askOf(user).slice(0, 40);
  if (sys.includes(IDEAMAP_RULE)) {
    const cx = Math.round(r.x + r.width / 2 - 60), cy = Math.round(r.y + r.height / 2 - 60);
    const add = [{ type: 'note', x: cx, y: cy, text: ask }];
    [['Who is it for?', 0, -1], ['First small step', 1, 0], ['What it needs', 0, 1], ['Why it matters', -1, 0]].forEach(([t, dx, dy]) => {
      const bx = cx + dx * 240, by = cy + dy * 240;
      add.push({ type: 'note', x: bx, y: by, text: t });
      add.push({ type: 'arrow', x1: cx + 60 + dx * 60, y1: cy + 60 + dy * 60, x2: bx + 60 - dx * 60, y2: by + 60 - dy * 60 });
    });
    return JSON.stringify({ say: 'Here is a map of your idea. Edit, move or delete any box.', add, next: ['Make a plan for the first step'] });
  }
  return JSON.stringify({ say: 'Here are two ideas.', add: [{ type: 'note', x: Math.round(r.x + 24), y: Math.round(r.y + 24), text: 'Idea one' },
    { type: 'note', x: Math.round(r.x + 192), y: Math.round(r.y + 24), text: 'Idea two' }], next: ['Turn these into a plan'] });
}
