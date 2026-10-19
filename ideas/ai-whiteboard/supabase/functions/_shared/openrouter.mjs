// THIS FILE IS FOR: the plug to OpenRouter (build plan 1.7). Builds the request, reads the stream, reports cost and outcome.
// Field names (models, provider.max_price, provider.zdr, reasoning.max_tokens, user) are UNVERIFIED until step 0.7 runs live.
import { createHash } from 'node:crypto';

// THIS SECTION IS FOR: the outgoing body. Every field is required; a missing one is a bug, not a default.
export function buildRequest({ pick, messages, person, stream = true }) {
  if (!pick || !pick.models || !pick.models.length || !pick.maxPrice) throw new Error('pick is incomplete');
  if (!person) throw new Error('person missing');
  const body = {
    models: pick.models,
    messages,
    stream,
    max_tokens: pick.answerBudget + pick.thinkingBudget,
    temperature: pick.temperature,
    user: createHash('sha256').update(String(person)).digest('hex').slice(0, 24), // a hash, never the raw id
    provider: { sort: pick.sort, data_collection: 'deny', zdr: true, max_price: pick.maxPrice },
    usage: { include: true }
  };
  if (pick.thinkingBudget > 0) body.reasoning = { max_tokens: pick.thinkingBudget };
  return body;
}

// THIS SECTION IS FOR: the user turn. With a board picture (base64 PNG, as the browser's boardPng() makes it) the content is
// the text then an image part, the OpenAI-style shape OpenRouter accepts; without one it stays a plain string.
export function userContent(text, imagePng) {
  if (!imagePng) return String(text);
  if (!/^[A-Za-z0-9+/]+=*$/.test(imagePng)) throw new Error('picture is not base64');
  return [{ type: 'text', text: String(text) }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imagePng } }];
}

// THIS SECTION IS FOR: keeping secrets out of errors and logs (I6).
function scrub(msg, secrets) {
  let s = String(msg);
  for (const k of secrets) if (k) s = s.split(k).join('[redacted]');
  return s.replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]');
}

// THIS SECTION IS FOR: one call. Returns { outcome, text, cost, generationId, model, error? }.
// outcome: ok | error_before_start | cut_off | unreadable | unknown | cancelled. error_before_start was not charged; unknown needs a flag.
// cancelled: the person stopped it after it was sent. It may still cost something, so it is billed like a cut-off (the hold waits
// for cleanup when the cost is unknown), but it says nothing about the model's health (ai_model_failures leaves it out).
// onStart(generationId) fires once, when the first chunk names the generation (the cleanup job's lookup key if the call dies later).
// onDelta(text) fires for each piece of answer text. A hook that throws is ignored: it must never change what the call cost.
export async function callOpenRouter({ baseUrl, apiKey, body, fetchImpl = fetch, signal, onStart, onDelta }) {
  const secrets = [apiKey];
  const safe = (fn, v) => { if (typeof fn === 'function') { try { fn(v); } catch (e) { /* a hook never breaks billing */ } } };
  const stopped = () => !!(signal && signal.aborted);
  if (stopped()) return { outcome: 'error_before_start', text: '', cost: 0, generationId: null, error: 'cancelled before it was sent' };
  let res;
  try {
    res = await fetchImpl(baseUrl + '/chat/completions', {
      method: 'POST', signal,
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return { outcome: stopped() ? 'cancelled' : 'unknown', text: '', cost: null, generationId: null, error: scrub(e && e.message, secrets) };
  }
  if (!res.ok) return { outcome: 'error_before_start', text: '', cost: 0, generationId: null, error: 'status ' + res.status };

  if (!body.stream) {
    try {
      const j = await res.json();
      if (j.id) safe(onStart, j.id);
      const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      const base = { cost: j.usage ? j.usage.cost : null, generationId: j.id || null, model: j.model || null };
      if (typeof text !== 'string') return { outcome: 'unreadable', text: '', ...base };
      safe(onDelta, text);
      return { outcome: 'ok', text, ...base };
    } catch (e) {
      return { outcome: 'unreadable', text: '', cost: null, generationId: null, model: null, error: scrub(e && e.message, secrets) };
    }
  }

  let text = '', cost = null, generationId = null, model = null, done = false, bad = false, buf = '';
  const eat = (line) => {
    if (!line.startsWith('data:')) return;
    const d = line.slice(5).trim();
    if (d === '[DONE]') { done = true; return; }
    try {
      const j = JSON.parse(d);
      if (j.id && !generationId) { generationId = j.id; safe(onStart, j.id); }
      if (j.model) model = j.model;
      if (j.usage && typeof j.usage.cost === 'number') cost = j.usage.cost;
      const c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
      if (typeof c === 'string' && c) { text += c; safe(onDelta, c); }
    } catch (e) { bad = true; }
  };
  try {
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { eat(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    }
    if (buf.trim()) eat(buf.trim());
  } catch (e) {
    const outcome = stopped() ? 'cancelled' : generationId ? 'cut_off' : 'unknown';
    return { outcome, text, cost, generationId, model, error: scrub(e && e.message, secrets) };
  }
  if (bad && !text) return { outcome: 'unreadable', text, cost, generationId, model };
  if (!done) return { outcome: stopped() ? 'cancelled' : generationId ? 'cut_off' : 'unknown', text, cost, generationId, model };
  return { outcome: 'ok', text, cost, generationId, model };
}
