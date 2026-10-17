/* THIS FILE IS FOR the AI Magic Toolbox in the browser (build plan 1.13): a third AI option that sends every ask through our server
   (/route, then /run) with a tester pass, instead of to a provider with the person's own key. No model names, keys or prompt templates
   live here; the server owns them. Loaded after note-resize.js, before app-01-providers.js, which adds it to the providers table.
   Off unless switched on: AIWB_SUPABASE.toolboxEnabled, or ?toolbox=on for one visit (?toolbox=local on this computer's dev server).
   ?toolbox=off always wins. The pure block is run by ai-client.test.js in node. */
(function () {
  'use strict';

  /* AICLIENT-PURE-BEGIN (no DOM, no network) */
  var LABEL = 'AI Magic Toolbox';
  /* off, on (the hosted functions) or local (the dev server on this computer only) */
  function mode(cfg, search, hostname) {
    var q = String(search || '').replace(/^\?/, '').split('&').reduce(function (o, kv) { var p = kv.split('='); if (p[0]) o[p[0]] = decodeURIComponent(p[1] || ''); return o; }, {});
    if (q.toolbox === 'off') return 'off';
    if (q.toolbox === 'local') return hostname === 'localhost' || hostname === '127.0.0.1' ? 'local' : 'off';
    if (q.toolbox === 'on' || (cfg && cfg.toolboxEnabled === true)) return cfg && cfg.url ? 'on' : 'off';
    return 'off';
  }
  /* where the functions and the balance door live */
  function endpoints(m, cfg, origin) {
    var base = m === 'local' ? origin : String(cfg.url).replace(/\/+$/, '');
    return { fn: base + '/functions/v1', rest: base + '/rest/v1', apikey: m === 'local' ? 'local' : cfg.anonKey };
  }
  /* newline-delimited JSON, read as it arrives: returns the complete lines and keeps the partial tail */
  function takeLines(buf) {
    var parts = buf.split('\n'), rest = parts.pop(), lines = [];
    parts.forEach(function (p) { if (p.trim()) { try { lines.push(JSON.parse(p)); } catch (e) { /* a broken line is skipped */ } } });
    return { lines: lines, rest: rest };
  }
  /* plain words for every way an ask can stop (build plan 1.20). Each error carries what the board's failure copy reads:
     kind, status and apiMessage, like the provider errors; final means the server already spent both attempts. */
  var WORDS = {
    missing: "That pass didn't work.", unknown: "That pass didn't work.", disabled: 'This pass was turned off.',
    paused: 'Your AI access is paused for now. Lilly can turn it back on.',
    insufficient: "You're out of AI credit for now. Ask Lilly for more.",
    rate: 'That was a lot of asks this hour. Try again in a bit.',
    blocked: "That ask can't run here.",
    too_big: 'The board is too big to send. Try a smaller part of it.',
    server: 'The AI service hit a snag. Try again in a minute.',
    cut_off: "The AI couldn't finish this twice in a row. Your ask is still here.",
    unreadable: "The AI's answer couldn't be read twice in a row. Your ask is still here.",
    unknown_outcome: "The AI didn't answer twice in a row. Your ask is still here.",
    error_before_start: "The AI didn't start, twice. Your ask is still here.",
    no_attempts_left: 'This ask already used both tries. Send it again for a fresh start.'
  };
  function errorFor(body, httpStatus) {
    var b = body || {}, reason = b.reason || 'server', status = Number(b.status || httpStatus || 0);
    var key = reason === 'unknown' && status === 502 ? 'unknown_outcome' : reason;
    var e = new Error(WORDS[key] || WORDS.server);
    e.reason = reason; e.apiMessage = e.message; e.final = true;
    /* keep 401 for a bad pass (the board then asks for a new one); paused is not a bad pass, so it gets 423 */
    e.status = reason === 'paused' ? 423 : status;
    e.kind = reason === 'cut_off' || reason === 'no_attempts_left' ? 'cut' : reason === 'unreadable' ? 'invalid' : 'http';
    if (e.kind === 'cut') e.apiMessage = 'ended early';
    return e;
  }
  /* AICLIENT-PURE-END */

  /* TODO (build plan 1.17, session memory): waits on gate G2, whether "Remember stuff" means board saving or AI memory. When it lands:
     keep the last 5 asks and what each did here, send them with each ask (the server caps their size and gates them with the rest),
     and show them as an editable "what I remember" list (repo rule 1). Nothing is remembered between asks until then. */
  var cfg = window.AIWB_SUPABASE || {};
  var MODE = mode(cfg, location.search, location.hostname);
  var END = MODE === 'off' ? null : endpoints(MODE, cfg, location.origin);
  var last = null; /* the newest answer's ticket, job and next-moves ticket (outcome logging and next moves read it) */

  function headers(pass) {
    var h = { 'content-type': 'application/json', apikey: END.apikey };
    if (pass) h.authorization = 'Bearer ' + pass;
    return h;
  }
  /* one POST to a function; a request the caller cancelled stays a cancel, anything else that stops it is a network error */
  async function post(name, pass, body, signal) {
    try { return await fetch(END.fn + '/' + name, { method: 'POST', headers: headers(pass), body: JSON.stringify(body), signal: signal }); }
    catch (e) { if (signal && signal.aborted) throw e; var ne = new Error('Network error'); ne.kind = 'network'; throw ne; }
  }
  async function postJson(name, pass, body, signal) {
    var res = await post(name, pass, body, signal);
    var data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !data || !data.ok) throw errorFor(data, res.status);
    return data;
  }

  /* /route: the ask box (the server's router picks the job) or a named job. Returns { ticket, job, steps, firstAsk } or { clarify }. */
  function route(o) {
    return postJson('route', o.pass, { ask: o.ask, summary: o.summary || null, job: o.job || null, second: !!o.second, hasImage: !!o.hasImage }, o.signal);
  }

  /* /run, streamed: onText gets the whole text so far, onChunk fires on each piece of answer (never on the keep-alive ticks). */
  async function runOnce(o) {
    var res = await post('run', o.pass, { ticket: o.ticket, ask: o.ask, board: o.board == null ? '' : o.board, image: o.image || null, advanceEm: o.advanceEm }, o.signal);
    if (!res.ok || !res.body) { var d = null; try { d = await res.json(); } catch (e) {} throw errorFor(d, res.status); }
    var reader = res.body.getReader(), dec = new TextDecoder(), buf = '', text = '', done = null;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      var got = takeLines(buf + dec.decode(r.value, { stream: true }));
      buf = got.rest;
      got.lines.forEach(function (l) {
        if (l.t === 'delta' && typeof l.d === 'string') { text += l.d; if (o.onChunk) o.onChunk(); if (o.onText) o.onText(text); }
        else if (l.t === 'done') done = l;
      });
    }
    if (!done) { var ce = new Error('The answer ended before it was finished.'); ce.kind = 'cut'; ce.apiMessage = 'ended early'; ce.canRetry = true; return { ok: false, canRetry: true, reason: 'cut_off', status: 502, lost: ce }; }
    return done;
  }

  /* One ask, start to finish: a ticket (from the caller, or a named-job /route), then up to two /run attempts on the same ticket.
     Attempt 2 is the server's: it moves to the next model and is charged only for what it uses. */
  async function ask(o, onText) {
    if (!o.ticket && !o.job) throw new Error('No job named for this ask'); /* never a silent way around /route */
    var a = o.ask != null ? String(o.ask) : String(o.text || '');
    var ticket = o.ticket;
    if (!ticket) ticket = (await route({ pass: o.key, ask: a, job: o.job, hasImage: !!o.imagePng, signal: o.signal })).ticket;
    for (var attempt = 1; attempt <= 2; attempt++) {
      var done = await runOnce({ pass: o.key, ticket: ticket, ask: a, board: o.board, image: o.imagePng, advanceEm: o.advanceEm, signal: o.signal, onText: onText, onChunk: o.onChunk });
      if (done.ok) { last = { ticket: ticket, job: done.job, next: done.next || null, ask: a, at: Date.now() }; return done.text; }
      if (!done.canRetry) throw done.lost || errorFor(done);
      if (onText) onText('');
    }
    throw errorFor({ reason: 'no_attempts_left', status: 403 });
  }

  /* the balance door (my_balance): a number for a live pass, null for an unknown or revoked one */
  async function balance(pass, signal) {
    var res = await fetch(END.rest + '/rpc/my_balance', { method: 'POST', signal: signal, headers: { 'content-type': 'application/json', apikey: END.apikey, authorization: 'Bearer ' + END.apikey }, body: JSON.stringify({ p_pass: pass }) });
    if (!res.ok) throw new Error('status ' + res.status);
    var v = await res.json();
    return typeof v === 'number' ? v : v == null ? null : Number(v);
  }

  /* next moves for a finished build (build plan 1.19): one cheap follow-up on the child ticket the build handed back */
  async function nextMoves(pass, signal) {
    var l = last;
    if (!l || !l.next) return [];
    var text = await ask({ key: pass, ticket: l.next, ask: l.ask, signal: signal });
    var m = /\{[\s\S]*\}/.exec(text || ''), o = null;
    try { o = m ? JSON.parse(m[0]) : null; } catch (e) { o = null; }
    return o && Array.isArray(o.next) ? o.next : [];
  }

  /* what the person did with an answer (build plan 1.20): a code only, fire and forget. withinMs: only if the answer is that recent. */
  function outcome(pass, code, withinMs) {
    if (!last || !pass) return;
    if (withinMs && Date.now() - last.at > withinMs) return;
    fetch(END.fn + '/outcome', { method: 'POST', headers: headers(pass), body: JSON.stringify({ ticket: last.ticket, code: code }) }).catch(function () {});
  }

  /* the provider-table entry: the connect modal, every "do we have a key" check and every call site use it like the others */
  var provider = {
    id: 'toolbox', label: LABEL, keyHint: 'tester pass', placeholder: 'tp_...', keyLabel: 'Tester pass', noun: 'pass', noModels: true,
    trust: 'Your pass stays on this device. Every ask runs through the AI Magic Toolbox.',
    defaults: { model: '', fastModel: '' },
    verify: async function (pass, signal) { return (await balance(pass, signal)) !== null; },
    balance: balance,
    complete: function (o) { return ask(o, null); },
    stream: function (o, onText) { return ask(o, onText); }
  };

  window.AIToolbox = {
    enabled: function () { return MODE !== 'off'; }, mode: MODE, provider: provider, route: route, ask: ask, nextMoves: nextMoves,
    outcome: outcome, last: function () { return last; }, forget: function () { last = null; }
  };
})();
