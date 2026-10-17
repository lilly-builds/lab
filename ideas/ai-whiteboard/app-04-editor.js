'use strict';
/* THIS FILE IS FOR the style bar and the note/text editors. Loaded after app-03-render.js, before app-05-pointer.js. Plain globals; no IIFE. */

  /* ---------- style bar ---------- */
  var propsEl = document.getElementById('props'), pStroke = document.getElementById('pStroke'), pFill = document.getElementById('pFill'), pNote = document.getElementById('pNote');
  var pSize = document.getElementById('pSize'), sizeBtns = pSize.querySelectorAll('[data-size]'), pMisc = document.getElementById('pMisc'), dashBtn = document.getElementById('dashBtn'), delBtn = document.getElementById('delBtn');
  var widthBtns = pMisc.querySelectorAll('[data-w]'), propsSig = '';
  function makeChips(parent, list, onPick) {
    list.forEach(function (c) {
      var b = document.createElement('button'), i = document.createElement('i');
      b.type = 'button'; b.className = 'chip'; b.setAttribute('aria-label', c[1]); b.setAttribute('aria-pressed', 'false'); b.dataset.val = c[0];
      if (c[0] === 'none') i.className = 'none'; else i.style.background = c[0];
      b.appendChild(i);
      b.addEventListener('click', function () { onPick(c[0]); });
      parent.appendChild(b);
    });
  }
  makeChips(pStroke, STROKES, function (v) { setStyle('strokeColor', v); });
  makeChips(pFill, FILLS, function (v) { setStyle('fill', v); });
  makeChips(pNote, NOTE_FILLS, function (v) { setStyle('fill', v); });
  widthBtns.forEach(function (b) { b.addEventListener('click', function () { setStyle('strokeWidth', Number(b.dataset.w)); }); });
  sizeBtns.forEach(function (b) { b.addEventListener('click', function () { setStyle('size', Number(b.dataset.size)); }); });
  dashBtn.addEventListener('click', function () { var s = selEl(); setStyle('dashed', !(s ? elDashed(s) : cur.dashed)); });
  delBtn.addEventListener('click', deleteSel);

  function setStyle(prop, val) {
    var s = selEl();
    if (s) {
      snap();
      if (s.type === 'text' && prop === 'strokeColor') { s.color = val; delete s.strokeColor; } else s[prop] = val;
      save();
    }
    if (prop === 'fill' && (!s ? false : s.type === 'note')) cur.noteFill = val;
    else cur[prop] = val;
    draw();
  }
  function deleteSel() {
    var s = selEl();
    if (!s) return;
    snap(); els = els.filter(function (e) { return e !== s; }); selId = null; save(); draw();
  }
  function markPressed(group, val) {
    group.querySelectorAll('.chip').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.val === val)); });
  }
  function renderProps() {
    var s = selEl(), t = s ? s.type : (SHAPES.indexOf(tool) >= 0 ? tool : tool === 'text' ? 'text' : null);
    var closed = isClosed(t), stroked = closed || t === 'line' || t === 'arrow' || t === 'pen' || t === 'text';
    var src = s || cur;
    var stroke = t === 'text' && s ? pick(s.color, STROKES, '#1e1e1e') : pick(src.strokeColor, STROKES, s && !src.strokeColor ? '#1e1e1e' : cur.strokeColor);
    var size = t === 'text' ? (s ? s.size : cur.size) : 0;
    var fill = t === 'note' ? pick(src.fill, NOTE_FILLS, '#bfd7ff') : pick(src.fill, FILLS, 'none');
    var width = s ? (nearWidth(elWidth(s)) || 2) : cur.strokeWidth;
    var dashed = s ? elDashed(s) : !!cur.dashed;
    var sig = [t, s && s.id, stroke, fill, width, dashed, size].join('|');
    if (sig === propsSig) return;
    propsSig = sig;
    propsEl.hidden = !t;
    pStroke.hidden = !stroked;
    pFill.hidden = !closed;
    pNote.hidden = t !== 'note';
    pSize.hidden = t !== 'text';
    sizeBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.dataset.size) === size)); });
    var lineish = closed || t === 'line' || t === 'arrow';
    widthBtns.forEach(function (b) { b.hidden = !(stroked && t !== 'text'); b.setAttribute('aria-pressed', String(Number(b.dataset.w) === width)); });
    dashBtn.hidden = !lineish; dashBtn.setAttribute('aria-pressed', String(dashed));
    delBtn.hidden = !s;
    pMisc.hidden = (widthBtns[0].hidden && dashBtn.hidden && delBtn.hidden);
    markPressed(pStroke, stroke); markPressed(pFill, fill); markPressed(pNote, fill);
  }

  /* ---------- note editor ---------- */
  var ta = document.getElementById('noteEdit');
  var tx = document.getElementById('textEdit');
  function placeEditor() {
    var el = els.filter(function (e) { return e.id === editing; })[0];
    if (!el) return;
    if (el.type === 'text') {
      var st = tx.style;
      var tp = toScreen(el.x, el.y);
      st.left = tp.x + 'px'; st.top = tp.y + 'px'; st.width = el.w + 'px'; st.transform = 'scale(' + view.z + ')';
      st.fontSize = el.size + 'px'; st.lineHeight = textLH(el) + 'px';
      st.color = pick(el.color, STROKES, '#1e1e1e');
      st.height = 'auto'; st.height = Math.max(textLH(el), tx.scrollHeight) + 'px';
      return;
    }
    var np = toScreen(el.x, el.y);
    ta.style.left = np.x + 'px'; ta.style.top = np.y + 'px'; ta.style.width = el.w + 'px'; ta.style.height = el.h + 'px'; ta.style.transform = 'scale(' + view.z + ')';
    ta.style.background = pick(el.fill, NOTE_FILLS, '#bfd7ff');
  }
  function editNote(el) {
    commitEdit();
    editing = el.id; ta.value = el.text || ''; ta.style.display = 'block'; placeEditor(); draw();
    ta.focus();
  }
  /* the on-screen keyboard shrinks the visual viewport; pan the board so the edited text stays visible */
  function keepInView() {
    if (!editing || tx.style.display !== 'block') return;
    var vv = window.visualViewport, top = vv ? vv.offsetTop : 0, bottom = top + (vv ? vv.height : H) - 16;
    var r = tx.getBoundingClientRect(), dy = 0;
    if (r.bottom > bottom) dy = r.bottom - bottom;
    if (r.top - dy < top + 12) dy = r.top - top - 12;
    if (!dy) return;
    view.y += dy / view.z; saveView(); draw(); placeEditor();
  }
  function editText(el, isNew) {
    commitEdit();
    if (!isNew) snap();
    editing = el.id; editNew = !!isNew;
    tx.value = el.text || ''; tx.style.display = 'block'; placeEditor(); draw();
    tx.focus();
    tx.setSelectionRange(tx.value.length, tx.value.length);
    setTimeout(keepInView, 60); setTimeout(keepInView, 350);
  }
  tx.addEventListener('input', function () { placeEditor(); keepInView(); });
  tx.addEventListener('blur', commitEdit);
  tx.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); tx.blur(); } });
  if (window.visualViewport) { window.visualViewport.addEventListener('resize', keepInView); window.visualViewport.addEventListener('scroll', keepInView); }
  function commitEdit() {
    if (!editing) return;
    var id = editing; editing = null;
    ta.style.display = 'none'; tx.style.display = 'none';
    var el = els.filter(function (e) { return e.id === id; })[0];
    if (el && el.type === 'text') {
      var v = tx.value.trim().slice(0, 2000), isNew = editNew;
      editNew = false;
      if (!v) {
        els = els.filter(function (e) { return e !== el; }); if (selId === id) selId = null;
        if (isNew) { undoStack.pop(); syncUndo(); }
      } else if (v === el.text && !isNew) { undoStack.pop(); syncUndo(); }
      else {
        el.text = v;
        if (tool === 'text') { setTool('move'); selId = id; }
      }
      save();
    } else if (el) {
      var v = ta.value.trim();
      if (!v) { els = els.filter(function (e) { return e !== el; }); }
      else if (v !== el.text) { snap(); el.text = v; fitNote(el); }
      save();
    }
    draw();
  }
  ta.addEventListener('blur', commitEdit);
  ta.addEventListener('keydown', function (e) { if (e.key === 'Escape') ta.blur(); });

