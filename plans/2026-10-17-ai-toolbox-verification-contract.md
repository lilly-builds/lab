# AI Magic Toolbox: Tier 4 verification contract (step 0.1)

Money is Tier 4: Stripe, our ledger, and OpenRouter must agree. Each invariant names the test that proves it.
Tests live in `ideas/ai-whiteboard/`. The client suites run in CI (`for f in ideas/ai-whiteboard/*.test.js`). Tests marked **DB** need a real
Postgres (`AI_TEST_DATABASE_URL`, a database made by `supabase/tests/scratch.sh`) and skip in CI's client job; they ran locally on Postgres 17.
The SQL policy suite runs in CI's database job, which has failed on every whiteboard PR since 2026-10-16 for a reason outside this
work (a template seed row breaks `templates_reserved_slugs` at `supabase start`); it passes 183/183 locally through `scratch.sh`.
Nothing here has run against the hosted project or the real OpenRouter. Those checks are phase 0 (steps 0.4 to 0.7).

| # | Invariant | Proving tests | Status (2026-10-17) |
|---|---|---|---|
| I1 | Every AI call holds before it starts; open holds plus settled spend never exceed the balance | `ai-db.test.js` (DB: 20 parallel $0.10 holds on $1.00, exactly 10 succeed; control without the lock lets all 20 through), `ai-billing.test.js` (the hold counts UTF-8 bytes, an upper bound in any language), `ai-route.test.js` (not enough balance: refused at the hold, nothing called); browser click-through (a one-cent tester is refused at the run's hold, balance stays above zero) | proven locally; the parallel test is DB-only |
| I2 | Every hold ends as settle, release, or a flag to Lilly; never dropped silently | `ai-cleanup.test.js` (unknown cost is flagged and kept), `ai-outcome.test.js` (DB: a cut-off hold stays open, then cleanup settles it by generation lookup), policy suite | proven locally against the OpenRouter mock |
| I3 | Settled cost equals OpenRouter `usage.cost`, failed attempts included | `ai-outcome.test.js` (DB: every ledger row equals the mock's charges to the millionth, the cut-off attempt included), `ai-openrouter.test.js`, `ai-route.test.js` | proven locally against the mock; the real `usage.cost` and `/generation` field names are step 0.7 |
| I4 | Key limit is always `max(granted - deducted, usage)` | `ai-limit-rule.test.js`, `ai-admin.test.js` (create and grant SET the key's limit), `ai-cleanup.test.js` (reconcile flags a mismatch, never fixes it), `ai-outcome.test.js` (DB: terminal grant moves the cap) | proven locally against the mock; real key limit updates are step 0.7 |
| I5 | A ticket allows at most two attempts, only for its person and ask hash | `ai-ticket.test.js`, `ai-db.test.js` (DB: 20 parallel attempts hand out exactly 1 and 2), `ai-outcome.test.js` (DB: attempt 3 refused), policy suite | proven locally |
| I6 | No key, pass, or prompt text in logs, responses, `ai_usage`, or the browser | `ai-outcome.test.js` (DB: every log line and every AI table searched for the pass, the provisioned key and the ask text; a planted debug log fails it), `ai-openrouter.test.js`, `ai-admin.test.js`, policy suite (`ai_usage` has no text column) | proven locally |
| I7 | Browser reads its own balance and writes nothing | policy suite (every `ai_`, `ledger_` and `ticket_` function and every AI table is closed to anon and authenticated; a leaked grant fails it) | proven locally; CI blocked by the seed failure above |
| I8 | Every AI entry point reaches the AI only via `/route` then `/run` | `ai-entrypoints.test.js` (every provider call on the board names its job), `ai-client.test.js` (no job and no ticket never leaves the browser), browser click-through of all five entry points | proven locally (CI runs both node tests) |

Passing bar for the ICP (a non-technical dreamer): an ask never silently costs more than their balance, a failure never charges for nothing they got,
and everything the AI puts on the board stays theirs to edit (repo CLAUDE.md rule 1). The browser run edited an AI idea-map note (moved, retyped,
deleted, undone, saved) exactly like a hand-made one.
Phase 2 adds the Stripe invariants (invoice, refund, dispute rows) to this table.
