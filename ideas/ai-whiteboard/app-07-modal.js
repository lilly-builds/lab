'use strict';
/* THIS FILE IS FOR the ask panel and the connect-key modal. Loaded after app-06-toolbar.js, before app-08-spatial.js. Plain globals; no IIFE. */

  /* ---------- ask panel ---------- */
  var xpanel = document.getElementById('xpanel'), xurl = document.getElementById('xurl'), embedBtn = document.getElementById('embedBtn'), makeRealBtn = document.getElementById('makeReal');
  var panel = document.getElementById('panel'), ask = document.getElementById('ask'), magic = document.getElementById('magic'), gear = document.getElementById('gear');
  function openPanel() {
    commitEdit();
    xpanel.classList.remove('open'); embedBtn.setAttribute('aria-expanded', 'false');
    panel.classList.add('open'); magic.setAttribute('aria-expanded', 'true');
    ask.focus();
  }
  function closePanel() {
    clearNote();
    panel.classList.remove('open'); xpanel.classList.remove('open');
    magic.setAttribute('aria-expanded', 'false'); embedBtn.setAttribute('aria-expanded', 'false');
  }
  /* the panel always opens: Make it real needs no key, and sending without one still asks to connect */
  magic.addEventListener('click', function () {
    if (panel.classList.contains('open')) closePanel();
    else openPanel();
  });
  gear.addEventListener('click', function () { openModal({ opener: gear }); });

  var errEl = document.getElementById('err'), errTimer = null;
  function showErr(msg) {
    errEl.textContent = msg; errEl.classList.add('show');
    clearTimeout(errTimer);
    errTimer = setTimeout(function () { errEl.classList.remove('show'); }, 3500);
  }

  panel.addEventListener('submit', function (e) { e.preventDefault(); send(); });

  /* ---------- typewriter hints (build plan 1.18): the empty box types out dream-builder prompts in its placeholder ---------- */
  /* HINTS-PURE-BEGIN (no DOM; exercised by ai-hints.test.js) */
  /* Lilly's prompts; ___ is the blank the person fills in. The third is TEMPORARY: her wording for it is still open (question 2). */
  var HINTS = ['My biggest dream is ___. Help me make it real.', 'I have to do ___ today. Get it done so I can focus on building my dream.',
    'I want to design today to be an adventure where we ___.'];
  var HINT_TYPE = 45, HINT_HOLD = 1800, HINT_ERASE = 18, HINT_GAP = 400;
  /* the placeholder at t ms into the cycle: type a prompt, hold it, erase it, pause, next prompt */
  function hintAt(list, t) {
    var lens = list.map(function (s) { return s.length * HINT_TYPE + HINT_HOLD + s.length * HINT_ERASE + HINT_GAP; });
    var total = lens.reduce(function (a, b) { return a + b; }, 0), u = ((t % total) + total) % total, i = 0;
    while (u >= lens[i]) { u -= lens[i]; i++; }
    var s = list[i], typed = s.length * HINT_TYPE;
    if (u < typed) return s.slice(0, Math.floor(u / HINT_TYPE));
    if (u < typed + HINT_HOLD) return s;
    var erased = Math.floor((u - typed - HINT_HOLD) / HINT_ERASE);
    return s.slice(0, Math.max(0, s.length - erased));
  }
  /* HINTS-PURE-END */
  var askPlaceholder = ask.getAttribute('placeholder'), hintTimer = null, hintT0 = 0;
  function stopHints() { clearInterval(hintTimer); hintTimer = null; ask.setAttribute('placeholder', askPlaceholder); }
  /* only on the AI Magic Toolbox, only while the box is empty and untouched; a click or a keystroke stops it. A placeholder is never sent. */
  function startHints() {
    if (hintTimer || PROVIDER !== 'toolbox' || ask.value) return;
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) { ask.setAttribute('placeholder', HINTS[0]); return; }
    hintT0 = Date.now();
    var shown = null;
    hintTimer = setInterval(function () {
      if (ask.value || !panel.classList.contains('open')) { stopHints(); return; }
      var s = hintAt(HINTS, Date.now() - hintT0) || ' ';
      if (s !== shown) { shown = s; ask.setAttribute('placeholder', s); }
    }, 50);
  }
  ask.addEventListener('pointerdown', stopHints);
  ask.addEventListener('keydown', stopHints);
  magic.addEventListener('click', function () { if (panel.classList.contains('open')) startHints(); else stopHints(); });

  /* ---------- connect modal: the only place a key is ever asked for ---------- */
  var dock = document.getElementById('dock'), scrim = document.getElementById('scrim'), dlg = document.getElementById('dlg');
  var provList = document.getElementById('provList'), keyForm = document.getElementById('keyForm'), keyField = document.getElementById('keyField');
  var fastField = document.getElementById('fastField'), fastIn = document.getElementById('fastModel');
  var keyIn = document.getElementById('key'), reveal = document.getElementById('reveal'), modelField = document.getElementById('modelField'), modelIn = document.getElementById('model');
  var connectBtn = document.getElementById('connectBtn'), manageRow = document.getElementById('manageRow'), replaceBtn = document.getElementById('replaceBtn'), disconnectBtn = document.getElementById('disconnectBtn');
  var stateEl = document.getElementById('state'), trustEl = document.getElementById('trust');
  var cOpen = false, cDraft = null, modalOpen = false, replacing = false, resumeSend = false, resumeReal = false, modalOpener = null, checking = null;

  /* the AI Magic Toolbox takes a tester pass, not a key: the same messages say "pass" for it */
  function setState(msg) {
    var p = providers[PROVIDER];
    stateEl.textContent = msg && p && p.noun ? String(msg).replace("That key didn't work.", 'That ' + p.noun + " didn't work.") : msg || '';
  }
  function setReveal(on) {
    keyIn.type = on ? 'text' : 'password';
    reveal.textContent = on ? 'Hide' : 'Show';
    reveal.setAttribute('aria-pressed', String(on)); reveal.setAttribute('aria-label', on ? 'Hide key' : 'Show key');
  }
  function renderModal() {
    provList.textContent = '';
    Object.keys(providers).forEach(function (id) {
      var p = providers[id], b = document.createElement('button'), dot = document.createElement('span'), name = document.createElement('span'), hint = document.createElement('span');
      b.type = 'button'; b.className = 'prov'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(id === PROVIDER));
      dot.className = 'dot'; name.textContent = p.label; hint.className = 'hint';
      hint.textContent = getKey(id) ? mask(getKey(id)) : p.keyHint;
      b.appendChild(dot); b.appendChild(name); b.appendChild(hint);
      b.addEventListener('click', function () {
        if (id === PROVIDER) return;
        PROVIDER = id; lsSet(KEY_PROVIDER, id); replacing = false; keyIn.value = ''; setState(''); renderModal();
      });
      provList.appendChild(b);
    });
    var p = providers[PROVIDER], connected = !!getKey(PROVIDER), managed = connected && !replacing;
    /* nobody picks a model on the AI Magic Toolbox, so its model fields never show */
    keyField.hidden = managed; connectBtn.hidden = managed; modelField.hidden = !connected || !!p.noModels; fastField.hidden = !connected || !!p.noModels; manageRow.hidden = !managed;
    keyIn.placeholder = p.placeholder; keyIn.setAttribute('aria-label', p.keyLabel || p.label + ' API key');
    modelIn.placeholder = p.defaults.model; modelIn.value = getModel(PROVIDER);
    fastIn.placeholder = p.defaults.fastModel; fastIn.value = getFastModel(PROVIDER);
    trustEl.textContent = p.trust || 'Your key stays on this device.';
    replaceBtn.textContent = 'Replace ' + (p.noun || 'key');
    if (managed && p.balance) showBalance(PROVIDER);
  }
  /* the toolbox's balance, read through the one browser door (my_balance); a newer read cancels an older one */
  var balanceAc = null;
  function showBalance(id) {
    if (balanceAc) balanceAc.abort();
    var ac = balanceAc = new AbortController();
    providers[id].balance(getKey(id), ac.signal).then(function (v) {
      if (!modalOpen || PROVIDER !== id || replacing) return;
      setState(v == null ? "That key didn't work." : 'Balance: $' + Number(v).toFixed(2));
    }, function () { if (!ac.signal.aborted && modalOpen && PROVIDER === id) setState("Couldn't read the balance right now."); });
  }
  function openModal(o) {
    o = o || {};
    modalOpener = o.opener || magic; replacing = !!o.replace; resumeSend = !!o.resume; resumeReal = !!o.real;
    keyIn.value = ''; setReveal(false); renderModal(); setState(o.message);
    scrim.hidden = false; dock.inert = true; modalOpen = true;
    (keyField.hidden ? replaceBtn : keyIn).focus();
  }
  function closeModal() {
    if (!modalOpen) return;
    if (checking) { checking.abort(); checking = null; }
    if (balanceAc) { balanceAc.abort(); balanceAc = null; }
    modalOpen = false; scrim.hidden = true; dock.inert = false;
    keyIn.value = ''; setReveal(false); setState('');
    (modalOpener || magic).focus();
  }
  document.getElementById('dlgClose').addEventListener('click', closeModal);
  scrim.addEventListener('pointerdown', function (e) { if (e.target === scrim) closeModal(); });
  reveal.addEventListener('click', function () { setReveal(keyIn.type === 'password'); keyIn.focus(); });
  modelIn.addEventListener('input', function () {
    var v = modelIn.value.trim();
    if (v) lsSet(kModel(PROVIDER), v); else lsDel(kModel(PROVIDER));
  });
  fastIn.addEventListener('input', function () {
    var v = fastIn.value.trim();
    if (v) lsSet(kFast(PROVIDER), v); else lsDel(kFast(PROVIDER));
  });
  replaceBtn.addEventListener('click', function () { replacing = true; setState(''); renderModal(); keyIn.focus(); });
  disconnectBtn.addEventListener('click', function () {
    lsDel(kKey(PROVIDER)); replacing = false; keyIn.value = ''; setState(''); renderModal(); keyIn.focus();
  });
  dlg.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeModal(); return; }
    if (e.key !== 'Tab') return;
    var f = Array.prototype.filter.call(dlg.querySelectorAll('button, input'), function (n) { return !n.disabled && n.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !dlg.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !dlg.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('keydown', function (e) { if (modalOpen && e.key === 'Escape') closeModal(); }, true);

  keyForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (keyField.hidden || checking) return;
    var key = keyIn.value.trim();
    if (!key) { keyIn.focus(); return; }
    if (/\s/.test(key)) { setState("That key didn't work."); return; }
    var prov = providers[PROVIDER], id = PROVIDER, ac = new AbortController();
    checking = ac; connectBtn.disabled = true; setState('Checking…');
    try {
      var ok = await prov.verify(key, ac.signal);
      if (ac.signal.aborted) return;
      if (!ok) { setState("That key didn't work."); return; }
      lsSet(kKey(id), key);
      if (getKey(id) !== key) { setState("Couldn't save on this device."); return; }
      var go = resumeSend, real = resumeReal;
      closeModal();
      if (go) { if (ask.value.trim()) { openPanel(); if (real) makeItReal(); else send(); } else openPanel(); }
    } catch (err) {
      if (!ac.signal.aborted) setState("Couldn't check that key. Try again.");
    } finally {
      if (checking === ac) checking = null;
      connectBtn.disabled = false;
    }
  });

