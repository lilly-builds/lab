# AI Magic Toolbox: build plan (phase 0 and phase 1)

Status: draft, 2026-10-17. Planning only, no feature code yet.
Source of truth: `plans/2026-10-14-ai-magic-toolbox-architecture.md` (draft v4). Research behind it: `plans/2026-10-14-invisible-ai-toolbox-brief.md`.
Branch: `invisible-ai-toolbox` (PR #214). Building starts only when Lilly replies "go" on the PR.
Paths: `index.html` means `ideas/ai-whiteboard/index.html`. Line numbers were rechecked on 2026-10-17 against main (fbe66a1).

## 0. Ground rules for every step

1. **Money is Tier 4.** Stripe, our ledger, and OpenRouter must agree on every purchase. Phase 1 has no Stripe, but the ledger,
   holds, settles, and the limit rule are built to Tier 4 standard now, because Lilly's real OpenRouter balance moves from day one.
2. **Never touch main, never merge, never deploy.** All work lands as commits on `invisible-ai-toolbox`. "Deploy" steps are Lilly's.
3. **No real keys, no real account calls.** Every test runs against a mock OpenRouter (step 0.2) and, in phase 2, Stripe test mode.
   Anything that needs Lilly's accounts is marked **[LILLY]** and listed in section 4.
4. **Everything that renders stays editable** (repo CLAUDE.md, rule 1). Each step that adds something visible has an
   "Editable check" line. The idea map's boxes and lines, next-move suggestions, memory entries, and failure notes are all in scope.
5. **Defaults Lilly can change** (marked DEFAULT everywhere they bite):
   - Open question 1: "first ask" means someone's first ask ever (not per board).
   - Open question 16: unused free credit expires monthly. (Phase 1 has no free-plan job, so this only shapes the ledger's `expire` reason.)
6. **Order of work inside a step:** write the failing test, make it pass, run the whole suite (`for f in ideas/ai-whiteboard/*.test.js; do node "$f"; done`,
   the same loop CI runs), then do the "Verify through the real path" line.
7. **This branch is never merged by me.** `ideas/` is served as a static site from main, so lifting the live-board freeze (G1) allows edits on this branch only. Merging, and anything that reaches the live board, is Lilly's call after phase 1 is verified.
   Throwaway probes (0.6) are deleted before any merge.
8. Nothing in `index.html` changes until the live-board freeze is lifted (gate G1). Server-side steps (1.1 to 1.12) don't touch it
   and can start as soon as Lilly says go.

### How server code is tested without changing CI

CI (`.github/workflows/whiteboard-db.yml`) runs every `ideas/ai-whiteboard/*.test.js` with plain node, plus the SQL policy suite on a local Supabase stack.
It has no Deno. So: all server logic that matters (rulebook, tickets, limit rule, prompt templates, OpenRouter plug, gate counters)
is written as dependency-free ES modules (`.mjs`) in `ideas/ai-whiteboard/supabase/functions/_shared/`. Each has a top-level
`ideas/ai-whiteboard/ai-*.test.js` file that `import()`s it, so the existing CI loop picks the tests up with no workflow edit.
The Edge Function entry files (`route/index.ts`, `run/index.ts`, ...) stay thin: parse the request, call the modules, return a response.
I can't edit `.github/workflows`; if Lilly wants function-level integration tests in CI (local Supabase plus `functions serve`), she or an admin adds that step (section 4).

## 1. Gates before building (Lilly)

| Gate | Needed before | Status |
|---|---|---|
| G1. Live-board freeze lifted | any edit to `index.html` or `loop1.js` (steps 1.13 onward) | asked on the PR |
| G2. Remember stuff verified (open question 8: is it board saving or AI memory) | step 1.17 (session memory) | asked on the PR |
| G3. Database check: is Supabase the right host (open question 10) | step 1.1 onward (migrations and functions are Supabase-shaped) | not answered; plan assumes Supabase |
| G4. Lilly's go on touching her OpenRouter account | steps 0.4 to 0.8 live runs | not yet asked |
| G5. Tier 4 verification contract written and read by Lilly | any phase 1 code (step 0.1 writes it) | to do |

## 2. Phase 0: prerequisites

Phase 0 produces decisions and measurements, not product code. Everything marked [LILLY] needs her accounts.

### 0.1 Tier 4 verification contract
- **Goal:** the architecture requires it before any phase 1 code. A one-page list of invariants and how each is proven.
- **Files:** new `plans/2026-10-17-ai-toolbox-verification-contract.md`.
- **Contents:** the invariants (below), each with the test that proves it and the step that builds it.
  - I1. Every AI call holds before it starts; the sum of open holds plus settled spend never exceeds the balance.
  - I2. Every hold ends as settle, release, or a flag to Lilly. A hold is never dropped silently.
  - I3. Settled cost equals OpenRouter's `usage.cost` for that generation, to the cent, including failed attempts.
  - I4. The key limit always equals `max(granted - deducted, current usage)` (the limit rule).
  - I5. A ticket allows two attempts at most, only for the person and ask hash it was issued for.
  - I6. No provisioned key, tester pass, or prompt text appears in logs, responses, `ai_usage`, or the browser.
  - I7. The browser can read its own balance and write nothing.
  - I8. Every AI entry point reaches the AI only via `/route` then `/run`.
- **Tests:** none (it's a doc). Review: a second agent reads it cold.
- **Verify through the real path:** each invariant names a test file; the contract is "done" when every named test exists in later steps. Phase 2 adds the Stripe invariants (invoice, refund, dispute rows) to this same doc.

### 0.2 Test doubles and local stack
- **Goal:** everything after this can run with no real account.
- **Files:** new `ideas/ai-whiteboard/supabase/functions/_shared/testing/mock-openrouter.mjs` (a tiny local HTTP server: chat completions streaming and non-streaming,
  `usage.cost`, `/key` create, `/key` update, `/generation` lookup, injectable failures: 5xx before the first chunk, cut-off mid-stream, unreadable JSON, slow stream);
  new `ai-mock-openrouter.test.js`.
- **Tests:** the mock itself: streams chunks, reports cost, cut-off and error modes behave as configured, key limit enforced.
- **Verify through the real path:** `supabase start` locally (Docker), then a throwaway function spike (not committed as product code) that imports a `.mjs` from `_shared/`
  and calls the mock through `supabase functions serve`. This proves `.mjs` imports and `fetch` to localhost work in the Edge runtime. If either fails, switch the modules to `.ts` before step 1.2 and note it here.
- Unknown: whether the sandbox running this has Docker. If not, this verification is Lilly's or CI's (section 4).

### 0.3 Idea-map prompt and quality-test harness
- **Goal:** compare open vs frontier models for the first-ask idea map using the same payload `draw` sends (system text, board summary, board picture).
- **Files:** new `ideas/ai-whiteboard/tools/ideamap-eval.mjs` (runs a fixed set of about 10 "dreams" against a model list, writes a results table; `--mock` mode for CI);
  new `plans/2026-10-17-ai-toolbox-phase0-results.md` (filled in as results arrive); new `ideas/ai-whiteboard/ai-ideamap-eval.test.js` (checks the harness's scoring on canned replies).
- **Scoring:** reply parses with the existing edit/draw parser; has a center note and 3+ branches; every branch is connected; nothing off-canvas; a human-readable score sheet for Lilly's taste call ("never feels dumb").
- **Verify through the real path:** `node tools/ideamap-eval.mjs --mock` passes. The live run is **[LILLY]** (step 0.5 below).

### 0.4 Safety-gate model pick **[LILLY]**
- **Goal:** choose the cheap check model and whether it reads pictures (architecture 4.3). If not, decide: separate image check or describe-in-text first.
- **Files:** new `ideas/ai-whiteboard/tools/gate-eval.mjs` and a small labeled set `tools/gate-cases.json` (benign asks, jailbreak attempts, prompt-injection inside board text, a picture case). Result recorded in the phase 0 results doc.
- **Tests:** `ai-gate-eval.test.js` checks scoring with canned verdicts.
- **Verify through the real path:** live run with Lilly's go (G4). Pass bar: blocks every labeled attack, no more than a stated share of false blocks on the benign set (Lilly sets the share; default 2%).

### 0.5 Live quality, cost, and timing runs **[LILLY]**
- **Goal:** (a) idea-map quality open vs frontier, (b) cost of one idea map including next moves, (c) timing, (d) the M markup input.
- **Files:** results into the phase 0 results doc. Uses `tools/ideamap-eval.mjs` live mode.
- **Output:** the first model allowlist (fills the placeholders in step 1.3), per-job `max_price`, `answerBudget`, `thinkingBudget`, and a cost per idea map to price the monthly plan from in phase 2.

### 0.6 Streamed answer past 150 seconds on the host **[LILLY]**
- **Goal:** confirm the Supabase Edge limit for streamed answers (assumed 150s free, 400s paid).
- **Files:** new throwaway `supabase/functions/stream-probe/index.ts` (a function that streams for 200s, then 380s). Delete after the result is recorded.
- **Verify through the real path:** deploying it to Lilly's project is hers (I never deploy). Record pass or fail in the results doc. Fail means build calls use the non-streaming fallback or a shorter cap (architecture 4.5).

### 0.7 OpenRouter mechanics probe **[LILLY]**
- **Goal:** close the architecture's UNVERIFIED items: key create with hard `limit`; key update accepts a new `limit`; `GET /api/v1/generation` returns cost; the cap holds under parallel calls;
  a call with every field from step 1.7 (`models`, `provider.*`, `max_price`, `reasoning.max_tokens`, `user`) is accepted and honored; a pre-start error response is not charged; a cut-off answer is charged.
- **Files:** new `ideas/ai-whiteboard/tools/openrouter-probe.mjs` (reads the master key from an env var, never from a file; refuses to run without `--confirm`). Runs the same assertions against the mock first (`--mock`), then live.
- **Tests:** `ai-openrouter-probe.test.js` runs `--mock`.
- **Verify through the real path:** live run with Lilly's go and a small prepaid balance with auto top-up OFF. If key-limit update isn't supported, the limit rule (architecture 5) needs a different mechanism (delete and recreate the key); stop and ask Lilly.

### 0.8 Phase 0 close-out
- **Files:** `plans/2026-10-17-ai-toolbox-phase0-results.md` finished; architecture doc updated: UNVERIFIED tags removed or changed, model allowlist section added.
- **Done when:** G3 answered, 0.4 to 0.7 recorded, and a stale-claims pass done on the architecture doc.

## 3. Phase 1: concierge (no Stripe)

Server steps first (they don't touch the board and can proceed during the freeze), then browser steps (after G1).
"Mock path" below means `supabase start` plus `supabase functions serve` with the OpenRouter base URL pointed at the step 0.2 mock.

### Server

**1.1 Database: core tables and access rules** (needs G3)
- Files: new `supabase/migrations/202610XXXXXX_ai_toolbox_core.sql` (timestamp set when written); extend `supabase/tests/policy_tests.sql`.
- Tables (names provisional, per architecture 4.6): `credit_ledger` (append-only, dollars, reasons, unique keys), `ai_keys`, `tester_passes` (hashed pass, person id, disabled flag),
  `ai_usage` (request id, generation id, person, model, job, latency, cost, outcome; no prompt text), `route_tickets`, `ops_flags` (what needs Lilly's eyes), `gate_blocks`, `limit_updates` (the retry queue, used by 1.8).
  `credit_ledger` rows carry a `bucket` (`free` or `paid`). `collab_bonus` is phase 2 and is not built.
- "Person" in phase 1 is the tester pass's id (no sign-in yet). Phase 2 maps it to the signed-in user; the column is named `person_id` and has no foreign key to `auth.users` until then.
- Rules: RLS on, no browser write grants on any of them. The browser may read only its own balance through one SECURITY DEFINER RPC `my_balance()`.
  `credit_ledger` rejects UPDATE and DELETE (trigger). Encrypted key columns are never selectable by `anon` or `authenticated`.
- Tests (SQL, in the existing suite): anon and authenticated cannot select or write any of these; the ledger rejects update and delete; duplicate `stripe_event_id`, `invoice_id`, `refund_id`, request id are rejected;
  `my_balance()` returns only the caller's number.
- Real path: `supabase db reset` twice (the repo's repeatability rule) then the policy suite, locally and in CI.

**1.2 Ledger functions: balance, hold, settle, release, adjust** (needs 1.1)
- Files: new migration `..._ai_toolbox_ledger_fns.sql`; extend `policy_tests.sql`; new `supabase/functions/_shared/ledger.mjs` (thin client that calls the RPCs); `ai-ledger.test.js`.
- RPCs (service role only): `ledger_place_hold(person, request_id, amount)` takes a per-person lock, computes balance minus open holds, and refuses if short;
  `ledger_settle(request_id, cost)`; `ledger_release(request_id)`; `ledger_adjust(person, amount, note)` for Lilly's hand-entered grants. Settle is idempotent on request id.
- Tests: two holds that together exceed the balance: the second fails; settle twice writes one row; settle for more than the hold is allowed (real cost can exceed an estimate) but writes an `ops_flags` row and never lets the balance be hidden; release returns the amount.
  A node test fires 20 parallel `place_hold` calls against the local stack and checks the open total never exceeds the balance (this is I1 under concurrency).
- Real path: the parallel test against `supabase start`.
- **Settle larger than the hold is a bug, not a normal path.** With `max_price` and `max_tokens` set, real cost can't legitimately pass the worst-case hold. If it ever does, the ledger still records the real cost (never hide money),
  writes a high-severity `ops_flags` row, and pauses that person's AI access until Lilly looks. A test against the mock asserts the hold formula (input estimate + `answerBudget + thinkingBudget` at `max_price`) is an upper bound for every job's rulebook row, including a picture payload.
- **Spend order** (decision 16, free before paid): phase 1 has only hand adjustments, so no attribution logic is built. The ledger carries a `bucket` column (`free` or `paid`) from 1.1 so phase 2 doesn't need a rewrite. Phase 2 builds free-first spending and expiry.
- **Pre-start failures:** an OpenRouter error response before any chunk (no generation id) was not charged, so 1.11 settles it to zero and releases the hold (a `release` row). Only an unknown outcome (dropped connection, no response) is kept and flagged by 1.12. Step 0.7 confirms OpenRouter doesn't charge pre-start errors.

**1.3 Limit rule (pure)**
- Files: new `_shared/limit-rule.mjs`; `ai-limit-rule.test.js`.
- `computeLimit(ledgerRows, currentUsage) -> dollars` = `max(granted - deducted, usage)`. Grants: paid, free, bonus, adjustment. Deductions: refund, dispute, expire (and restores for `refund failed` and `dispute restored`).
- Tests: the architecture's own example ($10 granted, $8 used, $10 refunded gives 8; a $10 renewal then gives 10); duplicates don't double count; empty ledger gives usage.
- Real path: used by step 1.8's limit setter and step 1.12's reconciler; their tests assert the same numbers.

**1.4 Rulebook (pure) and model allowlist**
- Files: new `_shared/rulebook.mjs` and `_shared/allowlist.json`; `ai-rulebook.test.js`.
- `pick(job, clues, payload, person)` returns `{ models, effort, answerBudget, thinkingBudget, sort, temperature, maxPrice }`. Table-driven. Fixed rows: router, gate, plan, todo, nextmoves.
  Pictures only pick image-capable models. Final values come from step 0.5. The code can be built before that with an allowlist marked `"status": "placeholder"`;
  `pick()` throws on a placeholder list unless `AI_ALLOW_PLACEHOLDERS=1` is set (local and mock only), so `/route` can't run live on guesses. A test covers the guard.
- Tests: no AI calls. Every row returns only allowlist models; picture payload excludes text-only models; unknown job throws; thinking budget is never taken out of the answer budget (build keeps its 9000-token answer, `index.html:3560`); `maxPrice` always set.
- Real path: read by the 1.9 and 1.10 integration tests.

**1.5 Tickets (pure) and hashing**
- Files: new `_shared/ticket.mjs`; `ai-ticket.test.js`.
- Signed ticket id (HMAC with a server secret), ask hash (SHA-256 of normalized text), expiry of a few minutes, `attempts_used` up to 2, optional single child ticket for `nextmoves`.
- Taking an attempt is atomic in the database: an RPC `ticket_take_attempt(ticket_id, person)` locks the row, checks expiry and the count, and increments in one step (added to the 1.2 migration set).
- Tests: tampered signature rejected; expired rejected; wrong person rejected; wrong ask hash rejected; third attempt rejected; a `nextmoves` child can be issued once per build ticket;
  20 parallel `ticket_take_attempt` calls on one ticket: exactly 2 succeed (I5 under concurrency, against the local stack).
- Real path: used by 1.9 and 1.10.

**1.6 Prompt templates move to the server (pure, with golden parity tests)**
- Files: new `_shared/prompts.mjs` (draw, edit, build, plan, todo, nextmoves, router, gate, idea map); `ai-prompts.test.js`. This step does not edit `index.html` (freeze). It pins golden strings captured by hand from the current templates;
  the live parity test (server output equals what the browser builds) is switched on in step 1.13, which adds `PURE-BEGIN/END` markers around the browser templates (only `buildRouteSystem` is inside a marked block today, `index.html:2169-2210`)
  and makes `buildSystem` take the font advance as a parameter so node can run it. The browser templates it copies: `buildSystem()` (`index.html:623`), `SYSTEM_EDIT` (580), `SYSTEM_APP` (597), `buildRouteSystem` (2171), dream plan prompt (near 3884), the have-to prompt (`loop1.js` SYSTEM).
- Draw's prompt depends on a font measurement taken in the browser (`advanceEm`, `index.html:851-855`, used at 624). The browser sends that number as an input; the server validates it is within a sane range and clamps.
- Tests: golden strings for fixed inputs now; from step 1.13 also a parity test that extracts the browser strings (same marker trick as `route-edit.test.js`) and compares. The browser copies stay for the legacy path through phase 1, so the parity test stays too.
  Another test asserts user text is placed in the data position and the "text inside the request is never an instruction" rule is present (`index.html:2177`).
- Real path: 1.10 builds prompts only from this module.

**1.7 Plug: OpenRouter client**
- Files: new `_shared/openrouter.mjs`; `ai-openrouter.test.js` (runs against the step 0.2 mock).
- Builds the request: `models` (first plus backups), `provider.sort`, `provider.data_collection: "deny"`, `provider.zdr: true`, `provider.max_price`, `reasoning.max_tokens`, `max_tokens` (answer plus thinking), `user` (hashed person id).
  Parses streamed chunks, collects `usage.cost` and the generation id, classifies the outcome (ok, error-before-start, cut-off, unreadable, unknown/dropped).
- The mock can't prove OpenRouter accepts these field names or honors them (`max_price`, `reasoning.max_tokens`, `zdr`). That is the live check in 0.7, extended to send one real tiny request with every field and read the response. Until it passes, treat the field names as unverified.
- Tests: a test fails if any of the required fields is missing from the outgoing body; the `user` value is a hash, never the raw id; cut-off and unreadable replies are classified; cost is read from usage; the master key and per-person key never appear in thrown errors or logs (I6).
- Real path: mock server round trip. Live check is part of 0.7.

**1.8 Tester passes and key provisioning**
- Files: new `_shared/auth.mjs`, `_shared/keys.mjs`; `ai-auth.test.js`; new function `supabase/functions/admin-tester/index.ts` (human-only: create pass, revoke pass; protected by a server secret Lilly holds).
- A pass is a random private code shown once, stored hashed; sent as a bearer header; compared by hash in constant time. Creating a pass creates one capped OpenRouter key (mock in tests), stores it encrypted (AES-GCM, key from a server secret), sets the limit from the ledger via `computeLimit`. Revoking disables the key.
- **Limit setter** (`_shared/limit-setter.mjs`): after every money event (pass creation, `ledger_adjust`, a settle that pushes usage past granted minus deducted; in phase 2 also refund, dispute, expire) it SETs, never adds to, the key's limit to `computeLimit(...)`.
  The admin grant function calls it right after `ledger_adjust`, so Lilly's hand grant raises the ledger and the OpenRouter cap together. A failure enqueues a retry.
- Retry queue for failed limit updates: `limit_updates` table (created in 1.1) and `_shared/limit-queue.mjs`.
- Tests: bad pass rejected; revoked pass rejected and its key disabled in the mock; encrypted key round-trips and is never returned by any response; limit update failure enqueues a retry and the retry sets (never adds to) the limit.
- Real path: against the mock, create then use then revoke a pass end to end. Creating a real pass needs Lilly's master key (section 4).
- **Open point:** how Lilly types the grant. Default: `ledger_adjust` called from the admin function. Her hand grant is the only way phase 1 testers get balance.

**1.9 Safety gate**
- Files: new `_shared/gate.mjs`; `ai-gate.test.js`.
- Built with a configurable gate model id so it doesn't wait on the live pick in 0.4; the final id is set after 0.4. If the gate model can't read pictures, pictures take the fallback chosen in 0.4 (a separate image check, or a text description made first and then gated). Both fallbacks are built behind one interface and tested on the mock.
- Runs the gate model through the plug (held and billed like any call), takes text and, when the model allows, the picture. A block writes `gate_blocks`; after N blocks (open question 14; DEFAULT N = 5 in 24 hours, a config value) the person's AI access pauses automatically and `ops_flags` gets a row. The pause is reversible; only a human makes anything permanent.
- Tests: mock gate verdicts; N blocks pauses; paused person gets a plain refusal from `/route` and `/run`; unpausing is an admin-only call; gate failure (error or junk) fails closed (blocks the call, doesn't pass it) and is reported as a server problem, not an accusation.

**1.10 `/route` function**
- Files: new `supabase/functions/route/index.ts`; `_shared/route.mjs`; `ai-route.test.js`.
- Flow: authenticate pass, check not paused, hold (router + gate worst case), gate the ask, router check (unless the job is named), rulebook, store ticket, return ticket id plus the pick's non-secret summary (job only; never the model).
  Router reply now includes `difficulty`, `stage`, `tone` (architecture 4.2). Junk reply falls back to draw, as today (`index.html:2233`).
  `firstAsk` is decided here from the person's history in `ai_usage` (DEFAULT: first ask ever).
- Also here (architecture section 6): rate limits per person and per IP (a small counter table with a window; limits are config values, DEFAULT 30 asks per person per hour, 120 per IP per hour), and hard size limits on the ask, board summary, session memory, and board picture before anything is held or sent (the hold's input estimate depends on them).
- Tests (mock path): over the rate limit refused; oversized payload refused before a hold is placed; unauthorized refused; paused refused; named job skips the router call but not the gate; router junk falls back to draw; the response never contains a model name or key; the router and gate holds settle to real cost.
- Real path: `curl`-style test script `tools/smoke-route.sh` against the local stack.

**1.11 `/run` function**
- Files: new `supabase/functions/run/index.ts`; `_shared/run.mjs`; `ai-run.test.js`.
- Flow: validate ticket and ask hash, build the prompt from `prompts.mjs`, gate the whole payload, hold, call with the stored pick, stream back, settle to `usage.cost`.
  An error response before the first chunk settles to zero and releases the hold (see 1.2); an unknown outcome (dropped connection) keeps the hold for 1.12.
  On error, cut-off, or unreadable reply: settle that attempt to its real cost, then (on the browser's second request with the same ticket) use the next model. A third request is refused (I5).
  `ai_usage` row is written when the call starts and filled in as chunks arrive. A Stop or closed tab (request aborted) triggers settle if the cost is known, else leaves the hold for the cleanup job.
- Tests (mock path): no ticket, expired ticket, mismatched ask all refused; attempt 1 cut-off then attempt 2 succeeds and both settle (two settle rows, two real costs); attempt 3 refused; picture payload gated and routed to an image-capable model; abort mid-stream leaves a recoverable hold; 6 parallel calls that together exceed the balance: later ones are refused at the hold.
- Real path: `tools/smoke-run.sh`, then browser steps below.

**1.12 Cleanup job, reconciler, and flags**
- Files: new `supabase/functions/cleanup/index.ts`, `supabase/functions/reconcile/index.ts`, `_shared/cleanup.mjs`, `_shared/reconcile.mjs`; `ai-cleanup.test.js`.
- Cleanup: settle orphaned holds by generation lookup; holds with unknown outcome and no generation id after N minutes (DEFAULT 10) get an `ops_flags` row and are kept (never quietly released); retry the `limit_updates` queue.
- Spend alerts (architecture section 6, runaway spend): the daily job also flags when daily spend or the sum of key usage crosses a configured threshold (DEFAULT: daily spend over $10 or a key above 80% of its limit). Thresholds are config values for Lilly to set.
- Reconcile (daily): compares ledger vs key limit by the limit rule, and (phase 2) Stripe. Flags only; never changes money (I2/I4).
- "Flag to Lilly" is an `ops_flags` row. How she gets told (email, push, a dashboard) isn't specified anywhere. See unresolved list.
- Scheduling (pg_cron or Supabase scheduled functions) is host configuration. I write the SQL/config file but can't enable it (section 4).
- Tests: orphan with generation id settles to the mock's cost; orphan without id is flagged and kept; mismatched limit is flagged and not fixed; flags are idempotent per cause so the same problem doesn't flag every day.

### Browser (after G1)

All browser work touches `index.html` and `loop1.js`. The current AI path (paste your own key, `providers`, `index.html:440-578`) stays working until the end of phase 1 behind a switch,
because removing it is a phase 2 decision (architecture decision 18 and the copy changes at `index.html:325`, `4002`).

**1.13 Browser AI client and tester-pass mode**
- Files: new `ideas/ai-whiteboard/ai-client.js` (pure parts marked `AICLIENT-PURE-BEGIN/END`); `ai-client.test.js`; `index.html` (script tag and one switch).
- Does: stores the tester pass on this device, calls `/route` then `/run`, reads the stream, does the attempt-2 request after a failure, exposes `ask(job, inputs)`. No model names, keys, or templates in the browser.
  Replaces every "do we have a key" check (`index.html:2248-2249`, `3532-3533`, `3769`, `3885-3886`, `loop1.js:74` and the hook at `3973`) with "do we have a tester pass or the old key" via one helper.
- Editable check: the pass entry field is a normal input; nothing about board content changes in this step.
- Tests: node tests of the pure parts (stream reader, retry rule, helper); `route-edit.test.js` and the other existing suites still pass.
- Real path: the board served locally (it's a static page), tester pass created against the mock stack in step 1.8, a headless-browser script (Playwright if it can be installed in the sandbox) drives the board. If not installable, Lilly clicks through the checklist in section 5.

**1.14 Entry point 1: the ask box**
- Files: `index.html` (`send()` at 2245, `routeRequest` 2223 replaced by the client call); `route-edit.test.js` updated (the parser moves server-side but `parseRoute` stays for the legacy path).
- Does: in tester mode `send()` calls `ask('route'...)`, and the result is placed through the existing handlers (draw reply, edit ops with the existing confirm note, build). The ambiguity question flow (`clar`) is kept.
- Editable check: results are ordinary board elements created by the same code as today. There is no `locked` field on board elements today (the `locked` at `index.html:3476` is animation state), so the test compares instead:
  an AI-placed note and arrow have exactly the same key set and types as a hand-made note and arrow, and survive the same select, move, retext, delete, and undo operations.
- Tests: handlers unchanged; add a mock-backed test for the ask round trip.
- Real path: type a question in the real box with the mock stack; see the answer land on the board; edit it.
- The browser's template copies stay in place for the legacy path through phase 1 and are deleted in phase 2, with the legacy path. Two copies means two places to edit; the 1.6 parity test is what keeps them from drifting.
- Also in this step: add the `PURE-BEGIN/END` markers and the `buildSystem` parameter change described in 1.6, and switch on the parity test.

**1.15 Entry points 2 to 5: Make it real, App Retry, Dream plan, Have-to loop, next moves**
- Files: `index.html` (`makeItReal` 3764, `startApp` 3528 including the Retry button at 3054, `dreamPlan` 3884, the Loop1 hook 3969-3975), `loop1.js` (41, 74).
- Do: each calls `ask(job, inputs)` with the job named. Make it real and Retry tie to `el.prompt` (`index.html:3543`) so the ticket hash matches the stored idea. Plan and todo use their fixed rulebook rows. Existing timeouts (`index.html:3537`: 300s build cap; `loop1.js` TIMEOUT_MS) stay.
- Each entry point is one commit with its own test and its own real-path check.
- Editable check: a built app frame keeps its idea text (`el.prompt`) editable and Retry rebuilds from the edited text; Dream plan and Have-to results land as normal notes. A test asserts these are unchanged from today's behavior.
- Tests: for each entry point, a mock-backed test: succeeds; fails once then attempt 2 succeeds; both fail leaves the idea text in the box (or the app in its failed state with the existing Retry) and says what happened.
- **A check that no entry point was missed:** a test greps `index.html` and `loop1.js` for any `providers[...]`/`.complete(` call reachable in tester mode and fails if one exists outside the legacy path. This is the guard for the "sneaking in through a side feature" threat and invariant I8.
- Real path: each of the five is clicked once on the mock stack.

**1.16 First ask: the idea map**
- Files: `_shared/prompts.mjs` (idea-map variant), `index.html` (placement of the result), tests.
- DEFAULT (Lilly can change): "first ask" is someone's first ask ever (decided server-side from history; the browser has no say). Others get the normal draw.
- The reply is a center note plus branches with connecting lines, placed with the same code the draw reply uses today. If the current draw schema can't express centre plus connected branches, extend the schema and its parser/validator, not a special case.
- Editable check: every box and every line is a normal element: select, move, retext, delete, undo. A test asserts element shape equals what a hand-drawn note and arrow produce.
- Tests: golden idea-map reply from the mock produces N notes and N arrows with no locked flags; a second ask from the same person does not get the idea-map variant.
- Real path: fresh tester pass, empty history, type a dream, see the map, edit a branch.
- Note the existing welcome-note seeding (`index.html:3983`) is unrelated: it triggers on an empty board, which is why it can't be the "first ask" signal.

**1.17 Session memory** (needs G2)
- Files: `ai-client.js`, `index.html`, `ai-memory.test.js`.
- The last few asks and what each did (job, a short result summary), held in the browser, sent with each ask (cap: 5 entries and a size limit). Origin as architecture 4.7: apps already store `el.prompt`.
- Editable check: memory is visible and editable. A small "what I remember" list the person can edit, remove from, or clear. (Without this it would be an invisible, locked piece of state.)
- Tests: follow-up ask includes prior entries; cap enforced; clearing removes them; entries never include the pass or any key.
- Real path: "make a plan for a bakery", then "more detail on the scents" works without restating it (a passing criterion).
- Blocked until Lilly says whether "Remember stuff" is board saving or AI memory.

**1.18 Typewriter hints**
- Files: `index.html` (the ask box at 267), `ai-hints.test.js`.
- Cycles three dream-builder prompts through the input's `placeholder` (not its value), stops on focus or click, never sent (a placeholder isn't a value). Third prompt pending (open question 2): ship two plus a clearly marked temporary third that Lilly replaces.
- Editable check: the hint is never a locked value; the box itself stays a normal input. Whether the hint wording itself must be user-editable is unresolved (section 6, U1).
- Tests: hint cycle stops after click; the ask value stays empty while hints run; pressing send with an empty box with hints showing sends nothing.

**1.19 Next moves**
- Files: `_shared/prompts.mjs`, `run` function (issues the child ticket), `index.html`.
- Draw and edit replies carry `nextMoves`; app builds trigger one cheap follow-up (the `nextmoves` row), held and billed.
- Editable check (DEFAULT): a tap puts the suggestion text into the ask box, where she can change it before sending. No auto-send. Suggestions are removable.
- Tests: nextmoves child ticket usable once; its cost settles; tapping fills the box and sends nothing; a failed follow-up doesn't affect the build result.

**1.20 Status words, failure copy, and outcome logging**
- Files: `index.html` (`PHRASES` at 2114 and `setPhrases`), `supabase/functions/outcome/index.ts`, `ai-outcome.test.js`.
- Job-specific status words; on double failure the ask stays in the box and the board says what happened in plain words (architecture 4.8).
- Outcome logging: redo, undo, edit, next-move tap go to `outcome`, which stores a code and ids only (never text). The browser can't write tables directly (I7).
- Editable check: the failure message appears as a dismissible note, and the ask text stays editable in the box. Status words are interface text; see U1.
- I6 test: a run on the mock stack captures every function log line and every `ai_usage`/`ops_flags` row and asserts neither the tester pass, the provisioned key, nor any prompt text appears.
- Tests: failure copy for each failure class; outcome call carries no text; per-model failure rates computed from `ai_usage` (the router stops picking a model that fails too often: threshold is an open number, default 10% over the last 50 calls).

**1.21 Phase 1 close-out**
- Files: `plans/2026-10-17-ai-toolbox-phase1-report.md`.
- Runs the whole checklist (section 5) on the mock stack, then lists what remains for Lilly's live run. Verification contract invariants I1 to I8 each marked proven (with the test name) or open.

## 4. What needs Lilly's accounts or admin rights (nothing is done for these)

- OpenRouter: a master/provisioning key in server secrets; a prepaid balance with auto top-up OFF; steps 0.4, 0.5, 0.7 live runs; creating real tester keys (1.8).
- Supabase: hosted project access; paid plan (phase 1 runs on one, per architecture 4.5); setting function secrets (master key, ticket secret, key-encryption secret); deploying functions; enabling scheduled jobs for cleanup, reconcile, limit queue; the 0.6 long-stream probe.
- Docker (for `supabase start` and the parallel-call tests) and a headless browser (Playwright) in whatever environment runs the steps. If the agent's environment lacks them, those verify lines move to Lilly or CI, and the step is reported as "tests written, real-path check not run", never as done.
- Enabling scheduled jobs (1.12) and anything that deploys.
- GitHub workflow: adding a local `supabase functions serve` integration step to `whiteboard-db.yml` (I can't edit workflow files). Optional.
- Stripe: nothing in phases 0 and 1. Phase 2 uses test mode first.
- A legal/OpenRouter item that is not a build step: OpenRouter's written OK (terms section 7) before charging anyone. Phase 1 charges no one.
- Anyone who gets a tester pass: Lilly chooses and enters the hand grants.

## 5. End-to-end checklist for phase 1 (mock stack, then live)

1. Create a tester pass; paste it once in the board.
2. First ask ever: an idea map lands; edit a branch, move a box, delete a line, undo.
3. Second ask: normal result; "more detail on <thing>" works.
4. Make it real, the app's Retry, Dream plan, Have-to loop, each once.
5. Force a cut-off on the mock: attempt 2 runs; two charges appear in the ledger; both match the mock's costs.
6. Force both attempts to fail: the ask stays in the box; board says what happened.
7. Stop mid-build: the hold settles (or is flagged); the balance is right.
8. Six builds at once with a small balance: later ones are refused cleanly.
9. Revoke the pass: next ask is refused; the OpenRouter key (mock) is disabled.
10. Search the network log, console, and database for the pass and the provisioned key: not present.
11. Everything on the board produced by AI is selectable and editable.

## 6. Skeptic review

A fresh reviewer who hadn't seen the plan's reasoning read it against the architecture doc, the repo rules, and the real code. It raised 29 points; most are fixed in the steps above.

Fixed:
- Settle above hold is now a flagged bug, with a test that the hold formula is an upper bound (1.2). Atomic ticket attempts, tested under parallel calls (1.5).
- Added the missing limit setter so a hand grant moves the ledger and the OpenRouter cap together (1.8). Fixed wrong cross-references in 1.3.
- Pre-start errors release the hold; only unknown outcomes are flagged (1.2, 1.11, 1.12). Probe 0.7 checks OpenRouter's charging for each case.
- Added rate limits, payload size limits, spend alerts, and the gate's picture fallback (1.9, 1.10, 1.12). Free-first spend order is deferred to phase 2 with a `bucket` column now (1.1, 1.2).
- 1.6 no longer needs `index.html`: golden strings now, parity test and markers in 1.13. Placeholder model list guarded at runtime instead of a CI check (1.4). `limit_updates` added to 1.1; "person" defined as the tester pass id.
- Removed the contradictory "delete browser copies" bullet (1.14). Editable checks added for entry points and rewritten to compare with hand-made elements, since no `locked` field exists (1.14, 1.15).
- Docker, Playwright, and scheduled jobs are listed as environment needs. The branch-stays-unmerged rule is stated in section 0.
- Checked claim 26: `index.html:3145` allows same-origin only for translated provider embeds (YouTube-style URLs), not AI-built apps (3245 stays `allow-scripts allow-forms`). The architecture's claim holds.

Could not resolve (needs Lilly or a decision):
- **U1. Does CLAUDE.md rule 1 cover interface text?** Typewriter hints (1.18), status words (1.20), buttons. I assumed rule 1 covers board content, AI output, memory, and next-move text, and not fixed interface chrome. If hint wording and status words must be user-editable, 1.18 and 1.20 each need a small settings surface. Next-move chips (1.19) fill the ask box so the text is editable before it's sent.
- **U2. Decision 18 vs the switch.** The architecture says no bring-your-own-key. The plan keeps today's key screen behind a switch during phase 1 so the live board doesn't break for people without a pass. If phase 1 must remove it, say so and 1.13 changes.
- **U3. How "flag to Lilly" reaches her** (email, push, dashboard). The plan writes `ops_flags` rows only.
- **U4. Numbers the plan had to default:** gate-block pause N = 5 per 24h (open question 14), rate limits, spend-alert thresholds, model failure threshold (10% over 50), orphan-hold wait (10 min), gate false-block share (2%). All are config values.
- **U5. CI can't run the function-level tests** (`functions serve` needs a workflow edit I can't make). Module tests, SQL tests, and the node parallel-call tests run in CI; the end-to-end function checks run locally or when Lilly adds the step.
- **U6. What the mock can't prove:** OpenRouter's real field names and behavior (0.7), the 150s+ stream limit (0.6), model quality and cost (0.5). Until those run live, steps depending on them are "built on assumption".
- **U7. Open question 1 and 16 defaults** are assumed (section 0) and need Lilly's yes or change before phase 2 for 16.
