# Plan: split `ideas/ai-whiteboard/index.html` into plain-global modules

Status: PLAN ONLY. No code changes ship with this document. Tracking: issue #223 (plan stage), #144 (the split), analysis in #221.
Base: all line numbers below are against the **base blob** `git show fb41c0b:ideas/ai-whiteboard/index.html` (main as of this plan). The inline script is lines 390 (`<script>`) to 4126 (`</script>`); the IIFE is 391 `(function () {` to 4125 `})();`; 392 is `'use strict';`.

Builder-manifesto mapping (docs/BUILDER-MANIFESTO.md): #1 this is the `/ce-plan` output, reviewed per `/ce-doc-review` (see "Review log"); #3 passing criteria are in section 5; #4 every new file opens with a `THIS FILE IS FOR X` header (section 1); #5 the four marker suites are retargeted and a manifest guard test is added (section 3); #6 the implementation PR gets a second-agent adversarial review before merge; #7 section 5 includes an agent-drives-the-page run.
Repo rule 1 (CLAUDE.md, NOTHING IS STATIC): the split moves bytes, it does not freeze anything. Every element the board can render today (notes, text, shapes, embeds, built apps, the welcome seed, template boards) stays editable, and the check is in section 5 (V8).

---

## 0. Decision and why

**Option 1: contiguous split in original load order, plain-global classic scripts, marker blocks kept verbatim, `opener` renamed, tests retargeted.**

Why this is the right size of change:
- The IIFE has no internal seams (100+ shared `var`s: `els`, `view`, `ctx`, `undoStack`, `busy`, ...). Converting to ES modules or an object-passing API would touch hundreds of lines and change behavior risk. Classic `<script>` files share one global scope, so every shared `var`/`function` keeps working with **zero rewriting of the code inside**.
- Cutting at the existing `/* ---------- section ---------- */` headers means each file is a section the code already treats as a unit, and the relative order of everything (function bodies, event-listener registration, `draw` override) is unchanged.
- No build step, no bundler: GitHub Pages serves the files as-is (same as juice.js, loop1.js, etc.).

Rules for the mover (all apply to every module):
1. **Move bytes verbatim.** No re-indent, no reformat, no renames except `opener` (R1). Tests match exact text including 2-space indent (note-resize.test.js:129 matches `function fitNote(el) {\n  ` + `if (el.sized) return;`; demo-safety.test.js:29 matches the whole `save()` line).
2. Each file starts with `'use strict';` (the IIFE's was the only strict-mode scope) and a header comment `/* THIS FILE IS FOR <purpose>. Loaded after <prev>, before <next>. Plain globals; no IIFE. */`.
3. Top-level `var`/`function` only. The IIFE has no top-level `let`/`const`; do not introduce any (they would not become `window` properties, which the denylist test in section 3 relies on).
4. Only **three** deliberate non-contiguous moves exist (M1-M3 below). Everything else is a straight line-range lift.

---

## 1. Target layout (load order = file order)

Files live flat in `ideas/ai-whiteboard/` (the CI glob `ideas/ai-whiteboard/*.test.js` and every test's `__dirname` read stay valid; no subfolder). Name prefix `app-NN-` encodes load order, and avoids colliding with `app-helpers.test.js` (different name, no collision).

Final `<head>`-to-`</body>` script block in index.html (replaces lines 381-390 and the inline script):

```html
<script src="juice.js"></script>
<script src="loop1.js"></script>
<script src="supabase-config.js"></script>
<script src="sync-engine.js"></script>
<script src="sync.js"></script>
<script src="auth.js"></script>
<script src="team.js"></script>
<script src="templates.js"></script>
<script src="note-resize.js"></script>
<script src="app-01-providers.js"></script>
<script src="app-02-state.js"></script>
<script src="app-03-render.js"></script>
<script src="app-04-editor.js"></script>
<script src="app-05-pointer.js"></script>
<script src="app-06-toolbar.js"></script>
<script src="app-07-modal.js"></script>
<script src="app-08-spatial.js"></script>
<script src="app-09-route.js"></script>
<script src="app-10-share.js"></script>
<script src="app-11-embeds.js"></script>
<script src="app-12-built-apps.js"></script>
<script src="app-13-make-it-real.js"></script>
<script src="app-14-loops.js"></script>
<script src="app-15-boot.js"></script>
```

The first nine tags are the existing 381-389 tags, **unchanged and in the same order** (demo-safety.test.js:18-24 asserts this order). The 15 app tags take the place of the inline `<script>`; they sit exactly where the inline script did (after `note-resize.js`, before `</body>`), so the DOM they query (`#board`, `#dock`, ...) already exists, same as today. Also add 15 `<link rel="preload" as="script" href="app-NN-....js">` hints in `<head>` (see risk L6); preload does not change execution order.

## 2. Modules: ranges, contents, exports

Notation: "orig" = base-blob lines. "Remaining-file lines" = where the block sits **in index.html while you are mid-split**, if you extract **bottom-up** (module 15 first) and add each new `<script src>` tag to the head as you go: each completed extraction adds exactly 1 line above every not-yet-extracted block, so before extracting the module at step *s* (module 15 is step 1, module 1 is step 15) its lines are `orig + (s-1)`. Removing a block from the tail never moves anything above it, which is why bottom-up is the prescribed order. (Alternative that avoids all shifting: cut every module from the pinned blob with `git show fb41c0b:ideas/ai-whiteboard/index.html | sed -n 'A,Bp'` and rewrite index.html once. Either is fine; the ranges below are authoritative for the blob.)

| # | File | orig lines | remaining-file lines at extraction (bottom-up, step s) | lines |
|---|------|-----------|------|------|
| 15 | app-15-boot.js | 3976-4124 (+M3 fonts 1118-1121) | s=1: 3976-4124 | ~153 |
| 14 | app-14-loops.js | 3824-3975 | s=2: 3825-3976 | 152 |
| 13 | app-13-make-it-real.js | 3736-3823 | s=3: 3738-3825 | 88 |
| 12 | app-12-built-apps.js | 3166-3735 | s=4: 3169-3738 | 570 |
| 11 | app-11-embeds.js | 2929-3165 | s=5: 2933-3169 | 237 |
| 10 | app-10-share.js | 2655-2928 | s=6: 2660-2933 | 274 |
| 9 | app-09-route.js | 2161-2654 minus 2358-2359 (M2), plus ROUTES 600-607 (M1) | s=7: 2167-2660 | ~500 |
| 8 | app-08-spatial.js | 1791-2160 | s=8: 1798-2167 | 370 |
| 7 | app-07-modal.js | 1661-1790 | s=9: 1669-1798 | 130 |
| 6 | app-06-toolbar.js | 1538-1660 | s=10: 1547-1669 | 123 |
| 5 | app-05-pointer.js | 1265-1537 | s=11: 1275-1547 | 273 |
| 4 | app-04-editor.js | 1123-1264 | s=12: 1134-1275 | 142 |
| 3 | app-03-render.js | 849-1117 + 1122 (M3 removes 1118-1121) | s=13: 861-1129 and 1134 | ~270 |
| 2 | app-02-state.js | 609-848 (+M2 num/str) | s=14: 622-861 | 240 |
| 1 | app-01-providers.js | 394-599 (M1 removes 600-607 from this region) | s=15: 408-613 | 206 |

The table assumes no stranded piece has been cut yet. The three moved pieces leave holes in index.html when their host module is extracted: ROUTES (8 lines) and `num/str` (2 lines) when module 9 goes (take 2161-2357 and 2360-2654 for the module body), the fonts block (4 lines) when module 3 goes. Any hole already cut shifts every block below it up by its size. The pinned-blob method sidesteps this and is the recommended one; the table is a cross-check (after each extraction, `grep -n` the next section header and confirm the listed line, adjusting for any hole already cut).

Final cleanup step: after module 1 is out, what remains of the inline script is `<script>`, `(function () {`, `'use strict';`, and the closing `})();`, `</script>`. Delete all five lines.

### The three non-contiguous moves (each fixes a concrete load-order break; see section 4)

- **M1** `var ROUTES = {...}` with its 3-line comment, orig 600-607: moves **out** of module 1's region and into the **top of app-09-route.js** (before `routeRequest`, orig 2231). Reason: its values `run: runDraw / runBuild / runEdit` are captured by value at load (L1), and those three functions are declared at orig 2314/2323/2330 inside module 9.
- **M2** `function num(v, d)` and `function str(v, n)`, orig 2358-2359: move **out** of module 9 and into **app-02-state.js**, directly after `selEl` (orig 847). Reason: `cleanEmbed`/`cleanApp`/`cleanText` (orig 708-804, module 2) call them, and `loadEls(s, true)` runs at load (orig 821) (L2).
- **M3** the `document.fonts.load(...)/fonts.ready` block, orig 1118-1121: moves **out** of module 3 and into **app-15-boot.js**, as its first statements (before the `LOOP1-HOOK`). Reason: `.then(draw)` fires as a microtask the moment module 3 finishes executing, i.e. before modules 4-14 exist (L3).

### Per-module detail

Each "exports" list is every top-level declaration in the range (they all become `window` properties; there is no export step). "Eager statements" are the top-level statements that run when the file loads and therefore constrain order.

**01 app-01-providers.js** (orig 394-599). Purpose: how the app talks to AI providers.
- Moves: streaming helpers (394-436), `providers` table (441-580), `SYSTEM_EDIT` (581-597), `SYSTEM_APP` (598-599). ROUTES (600-607) is **not** here (M1).
- Exports: `noStreamErr, openStream, httpErr, kindErr, sseErr, readSSE, providers, SYSTEM_EDIT, SYSTEM_APP`.
- Eager: `var providers = {...}` literal only (values are functions defined in the same literal). Needs nothing from other files.
- Depends on: nothing. Must be first.

**02 app-02-state.js** (orig 609-848, + M2). Purpose: palette, core state, storage, sanitizers, scene load/save.
- Moves: palette + `pick/nearWidth/isClosed/buildSystem` (609-649), state vars (651-658), zoom math with `zoom:start/end` markers (660-670), `toWorld/toScreen`, `lsGet/lsSet/lsDel`, provider credential helpers, `PROVIDER`, `migrate()` IIFE (691-698), embed sanitizers (699-719), built-app block incl. **APP-PURE markers 723-766**, `APP_CSP` line 722, `cleanApp/clampSize/cleanText` (767-804), `loadEls/isHttps/embedCount` (806-819), the boot-time scene/view load (821-835), `ser/save/saveView/snap/syncUndo/newId/selEl` (837-847), then `num/str` (M2).
- Exports (state): `KEY_SCENE, KEY_VIEW, KEY_PROVIDER, OLD_KEY, OLD_MODEL, cv, ctx, els, view, tool, undoStack, editing, busy, fade, selId, eraseIds, cur, imgCache, NOTE, nextId, editNew, dpr, W, H, MIN_Z, MAX_Z, PROVIDER, PAGES, EMB_MAX, EMB_MIN_W, EMB_MIN_H, STALL, KEY_APP, APP_MAX_CHARS, APP_MAX_COUNT, APP_CSP, savedBoard, savedKeys, s, vv`. (`s`, `vv`, `savedKeys` are incidental leaks of top-level `var`s at orig 821-834; harmless, leave them, no rename.)
- Exports (functions): `STROKES, FILLS, NOTE_FILLS, WIDTHS, SHAPES, pick, nearWidth, isClosed, buildSystem, clampZ, zoomAround, screenToWorld, worldToScreen, toWorld, toScreen, lsGet, lsSet, lsDel, kKey, kModel, getKey, kFast, getModel, getFastModel, modelFor, mask, cleanUrl, cleanEmbed, cleanReply, remoteRef, isFontLink, scrubApp, sanitizeApp, cleanApp, clampSize, cleanText, loadEls, isHttps, embedCount, ser, save, saveView, snap, syncUndo, newId, selEl, num, str`.
- Eager statements: `cv/ctx` lookup (needs `#board` in DOM), `PROVIDER = providers[...]` (needs 01), `migrate()`, scene+view load `loadEls(s, true)` (needs `cleanEmbed/cleanApp/cleanText/num/str/clampZ/lsGet`, all in this file after M2), the `sceneKeys` checkpoint. `syncUndo` is only *defined* here.
- Depends on: 01 (`providers`). `buildSystem` calls `advanceEm` (03) lazily, fine.

**03 app-03-render.js** (orig 849-1117 and 1122; M3 removes 1118-1121). Purpose: text layout, geometry, drawing, canvas resize.
- Moves: `FAMILY/FONT`, `advanceEm/wrap/fitNote/noteLayout/textLH/textBox`, geometry (`bbox/distSeg/hit/topAt/handles/handleAt`), images (`loadImage/getImage/syncImages`, `imgLayer`, `imgNodes`), `elWidth/elDashed/shapePath/drawEl/label/drawSel` (draws `NoteResize.paint(g, el, toScreen)` at orig 1088), `draw`, `resize`, and `window.addEventListener('resize', resize)` (1117).
- Exports: `FAMILY, FONT, imgLayer, imgNodes, advanceEm, wrap, fitNote, noteLayout, textLH, textBox, bbox, distSeg, hit, topAt, handles, handleAt, loadImage, getImage, syncImages, elWidth, elDashed, shapePath, drawEl, label, drawSel, draw, resize`.
- Eager: `getElementById('imgs')`, `addEventListener('resize', resize)`. (`draw` is not called at load.)
- Depends on: 02. `draw` calls `renderProps` (04), `syncZoomUI` (05), `syncEmbeds` (12) **only when invoked**, and nothing invokes it before module 15 (see L3).

**04 app-04-editor.js** (orig 1123-1264). Purpose: style bar and note/text editors.
- Exports: `propsEl, pStroke, pFill, pNote, pSize, sizeBtns, pMisc, dashBtn, delBtn, widthBtns, propsSig, makeChips, setStyle, deleteSel, markPressed, renderProps, ta, tx, placeEditor, editNote, keepInView, editText, commitEdit`.
- Eager: `makeChips(...)` x3, `forEach` listeners (`deleteSel` orig 1156, same file), `tx`/`ta` listeners using `commitEdit` (orig 1237, same file, hoisted), `visualViewport` listeners using `keepInView` (same file).
- Depends on: 02, 03. Same-file forward references are safe because function declarations hoist within a script; this is exactly why the cut is *not* placed between 1123 and 1264.

**05 app-05-pointer.js** (orig 1265-1537). Purpose: pointer/gesture/keyboard interaction and zoom UI.
- Exports: `drag, lastTap, interactId, ptrs, pinch, pt, styled, setView, zoomBy, zoomReset, ptrIds, pinchGeom, cancelDrag, ERASE_TOL, eraseCur, eraseHit, eraseTo, showEraseCur, endErase, end, up, zOut, zIn, zPct, syncZoomUI`.
- Eager: many `cv`/`window`/`document` listeners; `NoteResize.init({...})` (orig 1494, uses `selEl, toScreen, snap, save, draw`, all earlier); `syncZoomUI()` call (1529); dock/zoom-control IIFE (1531-1536).
- Registration-order note (L7): `cv` `pointerdown` here (1304) runs before the Dream (3940) and Want (3970) `cv` listeners; keeping the order keeps the order.
- Depends on: 02, 03, 04.

**06 app-06-toolbar.js** (orig 1538-1660). Purpose: shape flyout, tooltips, toolbar, undo.
- Exports: `shapeBtn, shapeFly, shapeItems, setShapeIcon, syncShape, closeFly, openFly, tip, tipTimer, tipHide, lpTimer, lpFired, hideTip, showTip, tipSel, tipTarget, toolBtns, prevTool, setTool, undo`.
- Eager: listeners; `syncUndo()` (1659, from 02).
- Depends on: 02, 04, 05.

**07 app-07-modal.js** (orig 1661-1790). Purpose: ask panel and the connect-key modal (the only place a key is asked for).
- Exports: `xpanel, xurl, embedBtn, makeRealBtn, panel, ask, magic, gear, openPanel, closePanel, errEl, errTimer, showErr, dock, scrim, dlg, provList, keyForm, keyField, fastField, fastIn, keyIn, reveal, modelField, modelIn, connectBtn, manageRow, replaceBtn, disconnectBtn, stateEl, cOpen, cDraft, modalOpen, replacing, resumeSend, resumeReal, modalOpener, checking, setState, setReveal, renderModal, openModal, closeModal`.
- **R1:** `opener` (orig 1698) is renamed `modalOpener` at its three uses: declaration 1698, assignment 1728 (`modalOpener = o.opener || magic`), read 1738 (`(modalOpener || magic).focus()`). The `opener:` **object key** in `openModal({ opener: ... })` is a property name, not a variable, and stays unchanged at the 10 call sites (orig 1680, 2257, 2299, 3541, 3633, 3777, 3894, 3905, 3981, 3982) and at `o.opener`.
- Eager: listeners; `dock`, `scrim`, `dlg`... lookups.
- Depends on: 02, 04. Exports the DOM handles (`ask`, `magic`, `dock`, `panel`) that 08-15 use at runtime; `cOpen` and `cDraft` are declared here but used by 10.

**08 app-08-spatial.js** (orig 1791-2160). Purpose: free-space/zones/cluster layout (pure helpers + DOM-free placement), board-to-model scene, busy state.
- Contains the **PURE block 1793-1873** (no test consumes it today; keep markers as-is).
- Exports: `rHit, rIn, snap8, freeRects, spiralSpot, shiftEls, moveWithArrows, safeRect, isLinear, okBox, obstacleBoxes, unionBox, boardBounds, computeZones, zoneArea, zoneSlots, fillZone, clashes, scrollToShow, layoutAdditions, sceneForModel, boardPng, PHRASES, statusEl, stopBtn, curAbort, phraseTimer, phraseSwap, timeoutTimer, timedOut, showPhrase, setPhrases, startBusy, endBusy, cancelSend`.
- Eager: `stopBtn.addEventListener('click', ...)` (2160; callback calls `cancelSend`, same file).
- Depends on: 02, 03, 07.

**09 app-09-route.js** (orig 2161-2654 minus 2358-2359, preceded by ROUTES per M1). Purpose: routing, send, the three handlers, reply parsing, edit route.
- Contains **ROUTE-PURE 2177-2218** and **EDIT-PURE 2445-2550** (both consumed by route-edit.test.js).
- Exports: `ROUTES, noteBox, noteText, noteChips, clar, pendingEdit, showNote, hideNote, clearNote, ROUTE_MIN_CONF, buildRouteSystem, firstJsonObject, parseRoute, needsAsk, DEFAULT_ASK, boardSummary, routeRequest, send, runDraw, runBuild, runEdit, parseReply, applyStyle, sanitize, freeSpot, applyReply, EDIT_MAX_OPS, EDIT_MAX_IDS, EDIT_DELETE_MAX, eNum, eClosed, eIn, validateEditOps, needsDeleteConfirm, editContext, pushSay, applyEdit`.
- Eager: `var ROUTES = {...}` (needs `runDraw/runBuild/runEdit`, same file, hoisted: this is why M1), `noteNo`/`noteYes` listeners.
- Depends on: 01 (providers), 02, 03, 07, 08.

**10 app-10-share.js** (orig 2655-2928). Purpose: share-as-template, community publish, `?template=`, invite links (`#board=` write side and `loadFromHash` read side).
- Exports: `cBtn, cScrim, cDlg, cForm, cMsg, cFields, EL_MAX, syncCommunity, drawBase, cHint, cXErr, X_RE, normX, openCommunity, closeCommunity, b64url, encodePayload, snapshot, loadTemplate, adoptBoard, invBtn, iPop, iMsg, iLink, iShare, iScrim, LINK_MAX, HASH_MAX, inviteBusy, inviteUrl, closePop, showPop, buildInvite, b64urlBytes, decodeBoard, askOpenFriend, loadFromHash`.
- Eager: `var drawBase = draw; draw = function () {...}` (orig 2673-2674) **reassigns the global `draw` binding**; `syncCommunity()` call (2784); listeners.
- Depends on: 02, 03, 07, 09 (`sanitize`/`applyReply` paths via adoptBoard at runtime).

**11 app-11-embeds.js** (orig 2929-3165). Purpose: link-to-embed translation and embed frames.
- Contains markers **`embedFor:start/end` 2930-2992** and **`isImageUrl:start/end` 2994-3005** (consumed by test-isimageurl.js).
- Exports: `NO_EMBED, noEmbedName, embedFor, IMAGE_HOSTS, isImageUrl, embedLayer, embedNodes, ICON_X, ICON_OPEN, ICON_TOUCH, ICON_STOP, ICON_RETRY, mk, embedById, isStalled, makeEmbedNode, flashHint, nodeOfBody, HINT_NAMES, dropFrame, showCard, armNote, updateEmbedNode`.
- Eager: `document.getElementById('embeds')`, two `document` listeners (3088, 3096).
- Depends on: 02, 03.

**12 app-12-built-apps.js** (orig 3166-3735). Purpose: built-app frames, the whirlwind animation, app build, add image/embed.
- Contains `whirlwind:start/end` 3304-3325 and the `var whirl = (function () {...})()` IIFE (3327-~3535).
- Exports: `gens, APP_FAIL, clock, appStatus, showBuilt, hideBuilt, failText, closePops, updateAppNode, APP_FIX, appDoc, appKeys, gcApps, storeApp, newAppId, firstWords, settle, stormStep, lockCount, whirl, startApp, addApp, publishApp, syncEmbeds, addImage, addEmbed, openEmbedPanel`.
- Eager: `whirl` IIFE (self-contained closure; it reads only DOM/`window` at load), `document` listeners (3207-3208, 3712-3725).
- Depends on: 02, 03, 07, 09 (`ROUTES.build`), 11. `APP_FIX` (3266) contains the text `<\/script>` inside a JS string: harmless in a `.js` file, keep verbatim.

**13 app-13-make-it-real.js** (orig 3736-3823). Purpose: prefilled issue, wait for the page, polling.
- Exports: `ISSUE, makeSlug, issueUrl, makeItReal, probing, probeUrl, checkLive, pollTick`.
- Eager: `makeRealBtn` listener (3781), `setInterval(pollTick, 15000)` (3821), `visibilitychange` listener (3822).
- Depends on: 02, 07, 11, 12.

**14 app-14-loops.js** (orig 3824-3975). Purpose: the additive Dream and Want loops (still deletable as a unit: delete the file and its tag).
- Contains **DREAM-LOOP 3824-3945**, the `Juice.circleOf` assignment (3946-3947), **WANT-LOOP 3949-3975**.
- Exports: `DREAM_DEFAULTS, DREAM_COPY, DREAM_SYSTEM, dreamBox, dreamRaf, dreamSnap, dreamFocus, dreamCircle, inDream, dreamClose, dreamPlace, dreamBubble, dreamOffer, dreamPlan, dreamWrite, dreamCheck, WANT_DEFAULTS, WANT_COPY, wantSnap, wantFocus, wantCheck`.
- Eager: `ta`/`cv` listeners (3933-3941, 3964-3971), `Juice.circleOf` guarded by `if (window.Juice)`.
- Depends on: 02, 03, 04, 07, 09, juice.js (loaded before the app files).

**15 app-15-boot.js** (orig 3976-4124, preceded by M3 fonts block). Purpose: hand the board to Loop1, boot, welcome seed, the sync surface, dispatch.
- Contains `LOOP1-HOOK` (3977-3984), `gcApps(); resize(); pollTick();` (3986-3988), `tplId` (3989), `seedWelcome` (3991-4112), `window.AIWB = {...}` (4113-4121), the `loadTemplate / loadFromHash / seedWelcome` dispatch (4122-4124).
- Exports: `tplId, seedWelcome, window.AIWB`.
- Eager: everything; this is the only file that may assume all other app files are loaded.
- Depends on: all of 01-14 + loop1.js, sync.js (reads `window.AIWB` lazily).

---

## 3. Test retarget map

Four suites named in the issue plus a fifth consumer the issue did not list (`test-isimageurl.js`, discovered by grepping every file for `index.html`; its name does not match the CI glob `*.test.js` so CI does not run it today).

| Suite | Marker / assertion | Lands in |
|---|---|---|
| app-helpers.test.js | `APP-PURE-BEGIN/END` (orig 723-766) and `var APP_CSP = "..."` (orig 722) | app-02-state.js |
| route-edit.test.js | `ROUTE-PURE-BEGIN/END` (orig 2177-2218), `EDIT-PURE-BEGIN/END` (orig 2445-2550) | app-09-route.js (both) |
| demo-safety.test.js | script order tags (unchanged, in index.html); `window.AIWB` literal (orig 4113-4121); `save()` line (orig 838) | index.html (tags), app-15-boot.js (AIWB), app-02-state.js (save) |
| note-resize.test.js | `note-resize.js` tag (index.html); `NoteResize.paint(...)` (orig 1088); `NoteResize.init({` (orig 1494); `function fitNote(el)` (orig 871) | index.html, app-03-render.js, app-05-pointer.js, app-03-render.js |
| test-isimageurl.js | `isImageUrl:start/end` (orig 2994-3005) | app-11-embeds.js |

Exact before/after edits. Everything not listed is unchanged. The regexes stay byte-identical because the code moves verbatim.

**app-helpers.test.js**
- line 2 comment: `Runs the APP-PURE block of index.html.` -> `Runs the APP-PURE block of app-02-state.js.`
- line 5 before: `const src = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');`
- line 5 after: `const src = fs.readFileSync(path.join(__dirname, 'app-02-state.js'), 'utf8');`
- lines 6 and 8 (regexes for the block and for `var APP_CSP = "..."`) unchanged: both live in the same file. Line 9's `new Function('APP_MAX_CHARS','APP_CSP', block + ...)` is unchanged; the block touches only its parameters and its own functions.

**route-edit.test.js**
- line 2 comment: `blocks of index.html` -> `blocks of app-09-route.js`.
- line 4 before: `const src = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');`
- line 4 after: `const src = fs.readFileSync(path.join(__dirname, 'app-09-route.js'), 'utf8');`
- lines 5-6 unchanged. The two blocks are concatenated and run together exactly as today; `num`/`str` (M2) were never inside either marker.

**demo-safety.test.js**
- line 8 before: `const html = fs.readFileSync(__dirname + '/index.html', 'utf8');`
  after (keep it, and add two reads directly below):
  ```js
  const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
  const boot = fs.readFileSync(__dirname + '/app-15-boot.js', 'utf8');
  const state = fs.readFileSync(__dirname + '/app-02-state.js', 'utf8');
  ```
- lines 18-25 (`order` array and loop) unchanged: those nine tags remain in index.html in the same order.
- line 27 before: `t('the inline script follows the sync tags', html.indexOf('src="sync.js"') < html.indexOf('window.AIWB'));`
  after: `t('the app scripts follow the sync tags', html.indexOf('src="sync.js"') < html.indexOf('src="app-01-providers.js"') && html.indexOf('src="app-15-boot.js"') > html.indexOf('src="sync.js"'));`
  (Why it must change: `window.AIWB` no longer appears in index.html, `indexOf` returns -1, and the old assertion would silently flip to false.)
- line 28 before: `... .test(html)`; after: `... .test(boot)` (same regex).
- line 29 before: `... .test(html)`; after: `... .test(state)` (same regex; the `save()` line is byte-identical).
- NEW assertions appended before `console.log('1..' + n)` (the manifest guard, section 5 V1):
  1. the fifteen `app-NN-*.js` tags exist in index.html in ascending NN order, all after `note-resize.js`, contiguous;
  2. every tag's file exists on disk;
  3. no inline `<script>` without `src` remains in index.html;
  4. `preload` hints match the script tags one-to-one (L6);
  5. none of a denylist of window-reserved names (`opener, top, parent, self, name, status, event, length, closed, frames, history, location, screen, origin, scroll, stop, find, print, open, close, focus, blur`) is declared as a top-level `var`/`function` in any `app-*.js` (L4). Regex over the module sources, `^\s{2}(var|function|async function) NAME\b`; for `var a, b = ...` lines also scan the comma list.

**note-resize.test.js** (lines 123-129)
- line 123 before: `const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');`
  after: keep it and add
  ```js
  const render = fs.readFileSync(path.join(__dirname, 'app-03-render.js'), 'utf8');
  const pointer = fs.readFileSync(path.join(__dirname, 'app-05-pointer.js'), 'utf8');
  ```
- line 124 title: `index.html wiring: script tag, paint, init hook, fitNote early return` -> `wiring: script tag, paint, init hook, fitNote early return (index.html + app modules)`.
- line 125 unchanged (`html.includes('<script src="note-resize.js"></script>')`).
- line 126 before: `assert.ok(html.indexOf('note-resize.js') < html.indexOf('NoteResize.init'),'module loads before the app script');`
  after: `assert.ok(html.indexOf('note-resize.js') < html.indexOf('src="app-05-pointer.js"'), 'module loads before the app scripts');`
  (`NoteResize.init` is no longer in index.html; without this edit `indexOf` is -1 and the assertion fails.)
- line 127 before: `assert.ok(/NoteResize\.paint\(g, el, toScreen\)/.test(html));` after: `.test(render)`.
- line 128 before: `assert.ok(/NoteResize\.init\(\{/.test(html));` after: `.test(pointer)`.
- line 129 before: `assert.ok(/function fitNote\(el\) \{\n\s+if \(el\.sized\) return;/.test(html));` after: `.test(render)`. This is why rule 1 forbids reformatting.

**test-isimageurl.js**
- line 1 comment: `as it appears in index.html` -> `as it appears in app-11-embeds.js`.
- line 3 before: `const src = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');` after: `... 'app-11-embeds.js' ...`.
- Decision for Lilly (non-blocking): rename it to `isimageurl.test.js` so the existing CI loop actually runs it. Not done in this plan; until then it is on the manual verification list (V6).

`.github/` is not touched: the workflow already runs `ideas/ai-whiteboard/*.test.js` and triggers on `ideas/ai-whiteboard/**`, which covers the new files.

Not affected (checked): `templates.test.js:359` reads `../templates/index.html`, a different file. `juice.js` and `loop1.js` only mention index.html in comments (update the comments as a courtesy: `index.html loads this file` stays true). `zoom:start/end` and `whirlwind:start/end` markers have no consumer; they stay verbatim in 02 and 12.

---

## 4. Risk list

### Load-order dependencies (L)

| ID | Dependency found | What breaks if naive | How the plan defuses it |
|---|---|---|---|
| L1 | `var ROUTES = {... run: runDraw, run: runBuild, run: runEdit}` (orig 603-607) captures three functions by value at load; they are declared at orig 2314/2323/2330. In one file they hoist; across files they do not. | Module 1 or 2 would throw `ReferenceError: runDraw is not defined` on every page load: the whole app dead. | **M1**: ROUTES moves into app-09-route.js, same file as the three functions. Guard: V1 manifest test + V2 browser run. |
| L2 | `num` / `str` are declared at orig 2358-2359 but called by `cleanEmbed` (713-715), `cleanApp` (771-773, 780), `cleanText` (794-800), and `loadEls(s, true)` runs eagerly at orig 821. | A fresh visitor (no saved scene) would not notice, because `arr.forEach` on `[]` never calls them. Any returning user with a saved board containing text, embeds or apps hits `ReferenceError` at load: a data-looking failure, the worst kind. Also `#board=` links decode through the same sanitizers (at runtime, later, so those would work: another reason this slips past a casual test). | **M2**: both move into app-02-state.js before `loadEls`. Guard: V3 (saved-board run) + a node test that evaluates app-01 + app-02 in `vm` with a stub `document`/`localStorage` holding a saved scene with one text, one embed and one app element, and asserts `els.length === 3`. |
| L3 | `document.fonts.load(...).then(draw, draw)` and `fonts.ready.then(draw)` (orig 1118-1121). A promise callback runs at the next microtask checkpoint, which happens **after each classic script finishes**, not after the whole page script. `draw` calls `renderProps` (04), `syncZoomUI` (05), `syncEmbeds` (12). | `draw` fires between module 3 and module 4: `ReferenceError` in a promise, board unpainted until the next event; flaky because it depends on font-cache timing. | **M3**: the block moves to the first lines of app-15-boot.js. |
| L4 | `draw = function () { drawBase(); syncCommunity(); };` (orig 2674) reassigns `draw`. Anything that captured `draw` **by value** before that line keeps the original: `Loop1`/`NoteResize.init` get `draw` at orig 1497 and 3978. | Behavior drift if the capture order changes. | Order is unchanged: NoteResize.init is in 05 (before 10), Loop1.init is in 15 (after 10). Assignment to a global function binding works across classic scripts. Keep identical (including the fonts `.then(draw)` capture, which moves in M3 to *after* the override: it now captures the **wrapped** `draw` instead of the original. Net effect: the first font repaint also calls `syncCommunity()`, which is idempotent and correct. Called out so the reviewer does not treat it as a regression; V1 `draw` test covers it). |
| L5 | Same-file forward references among eager statements: `deleteSel` (1143 -> 1156), `commitEdit` (1234, 1262 -> 1237), `keepInView` (1236 -> 1215), `up` (1492), `zoomReset` (1521), `closeFly/openFly` (1564-1565), `undo` (1647), `closeModal` (1740), `openCommunity` (2742), `makeItReal` (3781), `pollTick` (3821). | Each would break if a cut fell between the listener and the function. | Cuts are only at section headers; the table above shows each pair sits inside one module. Re-check with the lint in V1. |
| L6 | Fifteen sequential blocking scripts instead of one inline script: between two scripts the browser can run other tasks (a `resize`, `visibilitychange`, `pointerdown`) while the next file downloads. Listeners registered by early files could then fire before later files define the globals they call. | A rare `ReferenceError` in an early event handler on a cold, slow first load. | Preload hints in `<head>` fetch all 15 in parallel so execution is back-to-back from cache; every handler that touches late globals is only reachable after user input, and the first possible input is after parse. Residual risk accepted; V2 includes a throttled-network run. |
| L7 | Event-listener **registration order** on shared targets: `cv` `pointerdown`/`pointerup` (05 at 1304/1492, 14 at 3940/3941/3970/3971), `ta` `focus`/`blur` (04 at 1262, 14 at 3933-3934/3964-3965), `document` `keydown` (05, 06, 07, 10, 12). Order decides who sees an event first. | Behavior change in shared-element handlers. | Load order = original order, and no listener moves except the fonts block (not an input listener). Do not parallelize or reorder tags. |
| L8 | `sync.js` and `auth.js`/`team.js` load **before** the app files and call `window.AIWB` lazily. `window.AIWB` is now set in app-15 (last), same relative position as before (last statement group of the old IIFE). | sync would see `AIWB` undefined if it read it at load. | Unchanged relative order, asserted by the new line-27 check. |
| L9 | `Juice.circleOf` (3947) and `Loop1.init` (3978) need `juice.js` / `loop1.js`, which are classic scripts loaded earlier and guarded by `if (window.X)`. | none, as long as they stay before app-14/15. | Tag order in section 1; asserted by V1. |
| L10 | A throw in one classic script no longer aborts the rest (inside an IIFE a throw aborted all later statements; now module N+1 still runs and cascades into noisy `ReferenceError`s). | Harder to read failures; a 404 on one file yields a half-booted page. | V1 asserts every tag resolves to an existing file; V2 requires an **empty console**. |

### Window-collision candidates (C)

A top-level `var`/`function` in a classic script becomes a `window` property. For names that already exist on `window` as non-configurable or unforgeable properties, `var x = ...` does not create a new binding: it assigns to (or fails to override) the browser's property.

| ID | Candidate | Verdict | Defusal |
|---|---|---|---|
| C1 | `var opener = null` (orig 1698), assigned at 1728, read at 1738 | **Real collision.** `window.opener` is a built-in. `var opener = null` at global scope does not create a private binding: it writes to `window.opener`, nulling any reference to an opening window, and `opener = o.opener || magic` then writes a DOM element into a browser-owned property, so `(opener || magic).focus()` no longer reliably returns focus to the element that opened the modal. | **R1**: rename to `modalOpener` at all three uses. Object key `opener:` is not a variable and stays. Guard: denylist test (V1). |
| C2 | The other names closest to window properties: `label`, `clock`, `end`, `up`, `pt`, `mk`, `hit`, `snap`, `tip`, `panel`, `ask`, `state*` | Not `window` properties. Checked every top-level name in orig 394-4124 (about 330 functions, 100+ vars) against the reserved set `opener, top, parent, self, name, status, event, length, closed, frames, history, location, screen, origin, scroll, stop, find, print, open, close, focus, blur, external, performance, crypto, caches, fetch, alert, confirm, prompt, onerror`. Only `opener` matched. | Denylist test keeps it that way for future edits. |
| C3 | Element ids as named access on `window` (`#ask`, `#panel`, `#dock`, `#state`, `#key`, `#model`, `#note`, `#status`, `#err`, `#tip`, `#community`, `#invite`, `#magic`, `#board`, `#imgs`, `#embeds`, `#props`...). A bare identifier with the same name resolves to the element until a `var` of that name is declared. | In the IIFE the `var` shadowed these locally; now the `var` is a global own property which shadows the named-access one the same way. Each such id is assigned via `var x = document.getElementById('x')` in the same module that first uses it, before any use. | No action needed; do not introduce an *undeclared* use of an id name. V2 console-empty covers it. |
| C4 | Collisions with other scripts' globals: juice.js, loop1.js, sync.js, auth.js, team.js, templates.js, sync-engine.js, note-resize.js are all IIFE/UMD (grep of top-level statements: only `(function`/UMD wrappers and `window.AIWB_SUPABASE`). They export `Juice`, `Loop1`, `NoteResize`, `AIWB`, `AIWB_SUPABASE` and the UMD names. | None of the app's lowercase/camelCase names equals those capitalized exports. | Denylist test also checks app top-level names against the exported names of those scripts. |
| C5 | Incidental leaked vars `s`, `vv`, `savedKeys` (orig 821-834): previously IIFE-local. | Short names on `window`, no known collision; `draw`'s own `var s` shadows locally. | Leave as is (no renames beyond R1). Noted so nobody "fixes" it mid-move. |
| C6 | `var W`, `var H`, `var cur`, `var tool`, `var view` are generic. `whirl` has its own local `var W = {}` (orig 3328) which shadows the global `W` by design. | Shadowing, not collision. | Verbatim move preserves it; do not hoist or rename. |

### Other risks (O)

- O1 `'use strict'` per file: strict mode is per-script, so each file needs its own directive (rule 2). The IIFE's strictness covered only itself; nothing outside needs it.
- O2 Cache: GitHub Pages and browsers cache each `.js` independently. A user holding a stale `app-02` with a fresh `app-09` is possible for the cache TTL. Mitigation: all fifteen ship in one deploy; consider `?v=<n>` query on the tags if a stale mismatch is reported (not planned now).
- O3 Reviewability: a 4,000-line move shows as deletions plus new files. Use `git diff --color-moved=dimmed-zebra` in review and the V9 byte-identity check.
- O4 `test-isimageurl.js` is not in CI (section 3).
- O5 No browser harness exists in the repo, so V2-V8 are agent-driven (manifesto #7), not CI-gated, unless Lilly wants one added.

---

## 5. Verification contract: "identical behavior"

Definition: after the split, for the same inputs (a fresh profile, a profile with a saved scene, a `#board=` link, a `?template=` link, a demo-flag-off page), the user-visible behavior, the persisted data (localStorage keys and values), the network calls, and the console are identical to main at `fb41c0b`, and every existing suite passes with only the retargeting edits of section 3.

Passing criteria are written as the ICP would experience them (manifesto #3): *a person opens a board link or their saved board, draws, drags, resizes a sticky, asks the AI, and nothing looks or feels different, nothing is lost, and nothing is slower in a way they notice.*

| ID | Checkable claim | How to check | Proven by |
|---|---|---|---|
| V1 | Static integrity: 15 tags exist, ascending, after `note-resize.js`; files exist; no inline script left; preloads match; no reserved-name top-level declarations; sync tags precede app tags; `window.AIWB` surface and `save()` hook intact. | node | demo-safety.test.js (retargeted + new manifest assertions) |
| V2 | **Demo path** (flag off, fresh profile, no key): page loads, welcome seed animates and finishes (6 notes, 3 rings, manifesto note, blank note with editor open), zero console errors/warnings, **zero requests** to Supabase. | agent opens the page in a headless browser (manifesto #7), also with network throttled to Slow 3G, and captures console + network log | demo-safety.test.js (flag-off wiring) + sync.test.js (AE1/AE6 zero backend calls) + agent run |
| V3 | **Saved boards**: a profile whose `aiwb.scene` holds notes, text, shapes, a pending embed and an app embed loads with identical `els` (same ids, same fields) and identical `aiwb.sceneKeys` checkpoint; `loadEls` sanitizers behave as before (fixes L2). | node `vm` test of app-01+02 with stub storage (new, in app-helpers.test.js) + agent run with a seeded localStorage from a pre-split export | app-helpers.test.js (new case) + agent run |
| V4 | **`#board=` links**: build an invite link on main, open the same URL on the split build: board decodes to the same elements; `?template=<id>` loads the same template; a hash with oversize/foreign content is rejected identically. | agent compares `JSON.stringify(AIWB.getEls())` (the surface sync uses) for the same URL on both builds | agent run + templates.test.js + team.test.js (unchanged) |
| V5 | **Resize**: dragging the sticky corner resizes, `sized:true` persists, undo works, `fitNote` early-returns on sized notes, Ctrl+Z restores. | node + agent drag test | note-resize.test.js (retargeted: paint -> 03, init -> 05, fitNote -> 03) + agent run |
| V6 | **Helpers byte-identical in behavior**: cleanReply/sanitizeApp; route parser and edit-op validator; isImageUrl. | node | app-helpers.test.js (-> 02), route-edit.test.js (-> 09), test-isimageurl.js (-> 11, run manually until renamed) |
| V7 | **All loops**: (a) Have to loop via loop1.js: completing a note in the Have to circle earns Juice and the `Loop1.init` hooks are called with the same host (spot check `hasKey`, `needKey`, `badKey` open the key modal with focus returning to the sparkle button, the C1 behavior); (b) Dream loop: a note dropped into Dream gets one offer, no key -> key modal, bad key -> "That key didn't work."; (c) Want loop: a note in Want to do gets one playful bubble, no AI, no key; (d) listener order: moving a note out of a circle clears the snapshot without a bubble. | agent walkthrough of each loop on main and on the split build with identical outcomes recorded | agent run; no unit suite exists for juice.js or loop1.js today, so this row is agent-verified only; plus the C1 denylist test |
| V8 | **Nothing static** (CLAUDE.md rule 1): after the split the agent edits the text of a welcome-seed note, a template-loaded note, a ring label, a built-app embed title, moves and recolors each, and the edits persist across reload. | agent run | agent run (manual; no node equivalent) |
| V9 | **Move fidelity**: the multiset of non-blank lines in app-*.js equals the base inner IIFE (orig 394-4124), apart from the declared deltas: the three moves M1-M3 (relocated, same text), the `opener` -> `modalOpener` rename (3 lines), per-file `'use strict'` + header comments, and the removed IIFE wrapper. | script: `diff <(git show fb41c0b:ideas/ai-whiteboard/index.html | sed -n '394,4124p' | sort) <(cat app-*.js | sort)` and inspect only header/rename/strict lines | review artifact (manual, in the implementation PR) |
| V10 | Every existing suite runs green: `for f in ideas/ai-whiteboard/*.test.js; do node "$f"; done` (the CI loop) plus `node ideas/ai-whiteboard/test-isimageurl.js`. | node | all |
| V11 | Second-agent adversarial review before merge (manifesto #6), focused on L1-L10 and C1-C6, with the instruction to try to find one more eager cross-module reference. | review | implementation PR |

Gate: implementation PR may merge only if V1-V11 pass and the agent's V2/V3/V4/V7/V8 runs report an empty console and matching outcomes.

---

## 6. Implementation order (for the later /ce-build stage; not done now)

1. Branch from main; record `git rev-parse HEAD:ideas/ai-whiteboard/index.html` as the base blob.
2. Create the 15 files from the pinned blob per section 2 (apply M1-M3, R1, headers, `'use strict'`).
3. Rewrite index.html: add the 15 tags + preloads, delete the inline script (5 wrapper lines plus the body).
4. Apply the section 3 test edits and add the new manifest/vm tests.
5. Run V10, then V9, then the agent runs V2-V8.
6. Adversarial review (V11), then PR.

## 7. Out of scope

ES modules, bundling, renaming anything but `opener`, dedenting, adding `defer`, changing `.github/` or `supabase/`, renaming `test-isimageurl.js` (flagged for Lilly), any behavior change, and any cleanup of the leaked vars `s`/`vv`.

---

## Review log

Note: the `/ce-plan` and `/ce-doc-review` skills are not installed in this runner, so both stages were applied by hand as working stages (plan, then an adversarial re-read against the source).

- `/ce-plan` stage: gathered context (manifesto, issue #221 analysis re-verified against the file), mapped all section headers, marker blocks, eager top-level statements and every `index.html` consumer; produced sections 0-7.
- `/ce-doc-review` stage: re-read the plan adversarially against the source and corrected it. Findings folded in: (1) ROUTES forward references (L1/M1) were missing from the first draft; (2) `num`/`str` forward references from the eagerly run `loadEls` (L2/M2) were missing, which would only have surfaced for returning users; (3) the fonts microtask hazard (L3/M3); (4) a fifth consumer, `test-isimageurl.js`, outside CI; (5) `demo-safety.test.js:27` and `note-resize.test.js:126` silently invert when their `indexOf` target leaves index.html (-1), so they are edited, not just retargeted; (6) the line-shift arithmetic is replaced by a pinned-blob method with the shift table as a cross-check. Limits: the eager-reference scan was a read-through of the top-level statements, not a parser run (no parser in the repo); V1/V3 and the agent runs are the backstop for any miss.
