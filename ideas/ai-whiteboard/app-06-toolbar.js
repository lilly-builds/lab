'use strict';
/* THIS FILE IS FOR the shape flyout, tooltips, toolbar and undo. Loaded after app-05-pointer.js, before app-07-modal.js. Plain globals; no IIFE. */

  /* ---------- shape slot + tooltips ---------- */
  var shapeBtn = document.getElementById('shapeBtn'), shapeFly = document.getElementById('shapeFly');
  var shapeItems = Array.prototype.slice.call(shapeFly.querySelectorAll('[data-tool]'));
  function setShapeIcon(t) {
    var it = shapeItems.filter(function (b) { return b.dataset.tool === t; })[0];
    if (it) shapeBtn.innerHTML = it.innerHTML;
  }
  function syncShape(t) {
    var on = SHAPES.indexOf(t) >= 0;
    if (on) { setShapeIcon(t); try { localStorage.setItem('aiwb.shape', t); } catch (_) {} }
    shapeBtn.setAttribute('aria-pressed', String(on));
  }
  function closeFly(refocus) {
    if (shapeFly.hidden) return;
    shapeFly.hidden = true; shapeBtn.setAttribute('aria-expanded', 'false');
    if (refocus) shapeBtn.focus();
  }
  function openFly() {
    shapeFly.hidden = false; shapeBtn.setAttribute('aria-expanded', 'true');
    var r = shapeBtn.getBoundingClientRect(), w = shapeFly.offsetWidth, h = shapeFly.offsetHeight, vw = document.documentElement.clientWidth;
    var x = Math.max(4, Math.min(r.left + r.width / 2 - w / 2, vw - w - 4));
    var y = r.top - h - 4; if (y < 4) y = Math.min(r.bottom + 4, window.innerHeight - h - 4);
    shapeFly.style.left = x + 'px'; shapeFly.style.top = y + 'px';
    var cur = shapeItems.filter(function (b) { return b.dataset.tool === tool; })[0] || shapeItems[0];
    cur.focus();
  }
  shapeBtn.addEventListener('click', function () { commitEdit(); if (shapeFly.hidden) openFly(); else closeFly(false); });
  shapeItems.forEach(function (b) { b.addEventListener('click', function () { closeFly(true); }); });
  shapeFly.addEventListener('keydown', function (e) {
    var i = shapeItems.indexOf(document.activeElement), n = shapeItems.length;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); shapeItems[(i + 1) % n].focus(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); shapeItems[(i + n - 1) % n].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); shapeItems[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); shapeItems[n - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFly(true); }
  });
  document.addEventListener('pointerdown', function (e) {
    if (!shapeFly.hidden && !shapeFly.contains(e.target) && !shapeBtn.contains(e.target)) closeFly(false);
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeFly(false); });
  try { var savedShape = localStorage.getItem('aiwb.shape'); if (SHAPES.indexOf(savedShape) >= 0) setShapeIcon(savedShape); } catch (_) {}

  var tip = document.getElementById('tip'), tipTimer = 0, tipHide = 0, lpTimer = 0, lpFired = false;
  function hideTip() { clearTimeout(tipTimer); clearTimeout(tipHide); tip.hidden = true; }
  function showTip(el) {
    var text = el.getAttribute('aria-label'); if (!text) return;
    clearTimeout(tipHide);
    tip.textContent = text; tip.hidden = false;
    var r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight, vw = document.documentElement.clientWidth;
    var host = shapeFly.contains(el) ? shapeFly.getBoundingClientRect() : r;
    var x = Math.max(4, Math.min(r.left + r.width / 2 - w / 2, vw - w - 4));
    var y = host.top - h - 6; if (y < 4) y = Math.min(host.bottom + 6, window.innerHeight - h - 4);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  var tipSel = '#bar button, #bar a.tpl, #shapeFly button';
  function tipTarget(e) { return e.target.closest ? e.target.closest(tipSel) : null; }
  document.addEventListener('pointerover', function (e) {
    var el = tipTarget(e); if (!el || e.pointerType !== 'mouse') return;
    clearTimeout(tipTimer); tipTimer = setTimeout(function () { showTip(el); }, 400);
  });
  document.addEventListener('pointerout', function (e) { var el = tipTarget(e); if (el && !el.contains(e.relatedTarget)) hideTip(); });
  document.addEventListener('focusin', function (e) {
    var el = tipTarget(e); if (el && el.matches(':focus-visible')) showTip(el);
  });
  document.addEventListener('focusout', function (e) { if (tipTarget(e)) hideTip(); });
  document.addEventListener('pointerdown', function (e) {
    var el = tipTarget(e);
    if (e.pointerType === 'mouse') { hideTip(); return; }
    if (!el) return;
    lpFired = false; clearTimeout(lpTimer);
    lpTimer = setTimeout(function () {
      lpFired = true; showTip(el);
      clearTimeout(tipHide); tipHide = setTimeout(hideTip, 1500);
    }, 500);
  }, true);
  ['pointerup', 'pointercancel', 'pointermove'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      if (ev === 'pointermove' && e.pointerType === 'mouse') return;
      clearTimeout(lpTimer);
    }, true);
  });
  /* a long-press shows the label only: swallow the click that follows it */
  document.addEventListener('click', function (e) {
    if (lpFired) { lpFired = false; if (tipTarget(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }
  }, true);
  document.addEventListener('contextmenu', function (e) { if (tipTarget(e)) e.preventDefault(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideTip(); });

  /* ---------- toolbar ---------- */
  var toolBtns = document.querySelectorAll('[data-tool]');
  var prevTool = 'pen';
  function setTool(t) {
    if (t === 'erase' && tool !== 'erase') prevTool = tool;
    if (drag && drag.kind === 'erase') { drag = null; endErase(false); }
    tool = t; selId = null;
    if (t !== 'erase') eraseCur.style.display = 'none';
    cv.classList.toggle('erase', t === 'erase');
    toolBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.tool === t)); });
    syncShape(t);
    cv.classList.toggle('move', t === 'move');
    cv.classList.toggle('txt', t === 'text');
    draw();
  }
  toolBtns.forEach(function (b) { b.addEventListener('click', function () { commitEdit(); setTool(b.dataset.tool === 'erase' && tool === 'erase' ? prevTool : b.dataset.tool); }); });
  function undo() {
    commitEdit();
    if (!undoStack.length) return;
    els = JSON.parse(undoStack.pop()); save(); syncUndo(); draw();
  }
  document.getElementById('undo').addEventListener('click', undo);
  document.addEventListener('keydown', function (e) {
    if (modalOpen || cOpen) return;
    var tag = document.activeElement && document.activeElement.tagName, typing = tag === 'TEXTAREA' || tag === 'INPUT';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && selEl()) { e.preventDefault(); deleteSel(); }
    if (e.key === 'Escape') { if (busy) cancelSend(); else if (!noteBox.hidden) clearNote(); else closePanel(); if (tool === 'erase') setTool(prevTool); }
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'e') { e.preventDefault(); commitEdit(); setTool(tool === 'erase' ? prevTool : 'erase'); }
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 't') { e.preventDefault(); commitEdit(); setTool('text'); }
  });
  /* Templates is a plain link; flush the board first so nothing is lost on the way out */
  document.getElementById('tplLink').addEventListener('click', function () { commitEdit(); save(); saveView(); });
  syncUndo();

