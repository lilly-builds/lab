/* JUICE METER (stub): a bottle at the bottom-right that fills as notes get done.
   Self-contained. index.html only loads this file and calls Juice.earn(note) on completion. */
(function () {
  /* the economy, in one place: juice earned per completed note, by the circle it sits in */
  var JUICE = { 'have-to': 1, 'want-to': 2, 'dream': 10 };
  var CAP = 100;            /* the bottle reads full at this balance (visual only; the balance keeps counting) */
  var KEY = 'aiwb.juice';
  var FILL_MS = 400;
  var COLORS = { 'have-to': '#ffd8a8', 'want-to': '#b2f2bb', 'dream': '#d0bfff' }; /* sticky palette accents */

  var balance = 0, shown = 0, anim = 0, root, liquid, count;
  try { balance = Math.max(0, parseInt(localStorage.getItem(KEY), 10) || 0); } catch (e) {}
  shown = balance;

  function reduced() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function save() { try { localStorage.setItem(KEY, String(balance)); } catch (e) {} }

  function paint(v) {
    /* the liquid rect fills y 18..64 inside the bottle */
    var h = 46 * Math.min(1, v / CAP);
    liquid.setAttribute('y', String(64 - h));
    liquid.setAttribute('height', String(h));
    count.textContent = String(balance);
    root.setAttribute('aria-label', 'Juice: ' + balance);
  }
  function animateTo(target) {
    cancelAnimationFrame(anim);
    if (reduced()) { shown = target; paint(shown); return; }
    var from = shown, t0 = performance.now();
    (function step(now) {
      var p = Math.min(1, (now - t0) / FILL_MS), e = 1 - Math.pow(1 - p, 3); /* ease-out */
      shown = from + (target - from) * e; paint(shown);
      if (p < 1) anim = requestAnimationFrame(step);
    })(t0);
  }
  function floatText(n) {
    var f = document.createElement('div');
    f.className = 'juice-float'; f.textContent = '+' + n;
    root.appendChild(f);
    if (reduced() || !f.animate) { setTimeout(function () { f.remove(); }, 900); return; }
    f.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-34px)' }], { duration: 900, easing: 'ease-out' })
      .onfinish = function () { f.remove(); };
  }

  function build() {
    var st = document.createElement('style');
    st.textContent = '#juice{position:fixed;right:calc(12px + env(safe-area-inset-right));bottom:calc(var(--dockH,72px) + 8px);z-index:9;width:44px;text-align:center;pointer-events:none;font:12px/1 "Special Elite","Courier New",monospace;color:#1e1e1e;user-select:none;-webkit-user-select:none}' +
      '#juice svg{display:block;width:44px;height:58px;overflow:visible}' +
      '#juice .jl{display:block;margin-top:2px}#juice .jc{display:block;margin-top:2px;font-size:11px;opacity:.7}' +
      '.juice-float{position:absolute;left:0;right:0;top:6px;font:700 15px/1 "Special Elite","Courier New",monospace;color:#1e1e1e;pointer-events:none}';
    document.head.appendChild(st);
    root = document.createElement('div');
    root.id = 'juice'; root.setAttribute('role', 'img');
    var bottle = 'M15 18h14v8c6 4 9 9 9 16v16c0 4-3 6-6 6H12c-3 0-6-2-6-6V42c0-7 3-12 9-16z';
    root.innerHTML = '<svg viewBox="0 0 44 70" aria-hidden="true">' +
      '<defs><clipPath id="juiceClip"><path d="' + bottle + '"/></clipPath></defs>' +
      '<rect id="juiceLiquid" x="0" y="64" width="44" height="0" fill="#ffec99" clip-path="url(#juiceClip)"/>' +
      '<path d="' + bottle + '" fill="none" stroke="#1e1e1e" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<rect x="14" y="10" width="16" height="7" fill="#fff" stroke="#1e1e1e" stroke-width="1.6"/></svg>' +
      '<span class="jl">juice</span><span class="jc"></span>';
    document.body.appendChild(root);
    liquid = root.querySelector('#juiceLiquid'); count = root.querySelector('.jc');
    paint(shown);
  }

  var api = {
    JUICE: JUICE,
    /* index.html sets this: note -> 'have-to' | 'want-to' | 'dream' | null */
    circleOf: function () { return null; },
    balance: function () { return balance; },
    /* call when a note is completed; circle is optional, otherwise resolved via Juice.circleOf(note) */
    earn: function (note, circle) {
      var c = circle || api.circleOf(note);
      var n = JUICE[c];
      if (!n || !root) return 0;
      balance += n; save();
      liquid.setAttribute('fill', COLORS[c] || '#ffec99');
      animateTo(balance); floatText(n);
      if (api.onEarn) { try { api.onEarn(note); } catch (e) {} } /* sync.js: ledger write when synced */
      return n;
    },
    /* server-authoritative balance (synced mode): the ledger sum replaces the local count */
    setBalance: function (n) { balance = Math.max(0, n | 0); save(); animateTo(balance); },
    onEarn: null
  };
  window.Juice = api;

  if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
})();
