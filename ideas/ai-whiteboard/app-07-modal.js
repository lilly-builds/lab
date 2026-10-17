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

  /* ---------- connect modal: the only place a key is ever asked for ---------- */
  var dock = document.getElementById('dock'), scrim = document.getElementById('scrim'), dlg = document.getElementById('dlg');
  var provList = document.getElementById('provList'), keyForm = document.getElementById('keyForm'), keyField = document.getElementById('keyField');
  var fastField = document.getElementById('fastField'), fastIn = document.getElementById('fastModel');
  var keyIn = document.getElementById('key'), reveal = document.getElementById('reveal'), modelField = document.getElementById('modelField'), modelIn = document.getElementById('model');
  var connectBtn = document.getElementById('connectBtn'), manageRow = document.getElementById('manageRow'), replaceBtn = document.getElementById('replaceBtn'), disconnectBtn = document.getElementById('disconnectBtn');
  var stateEl = document.getElementById('state');
  var cOpen = false, cDraft = null, modalOpen = false, replacing = false, resumeSend = false, resumeReal = false, modalOpener = null, checking = null;

  function setState(msg) { stateEl.textContent = msg || ''; }
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
    keyField.hidden = managed; connectBtn.hidden = managed; modelField.hidden = !connected; fastField.hidden = !connected; manageRow.hidden = !managed;
    keyIn.placeholder = p.placeholder; keyIn.setAttribute('aria-label', p.label + ' API key');
    modelIn.placeholder = p.defaults.model; modelIn.value = getModel(PROVIDER);
    fastIn.placeholder = p.defaults.fastModel; fastIn.value = getFastModel(PROVIDER);
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

