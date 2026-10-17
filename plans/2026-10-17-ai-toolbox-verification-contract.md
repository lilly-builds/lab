# AI Magic Toolbox: Tier 4 verification contract (step 0.1)

Money is Tier 4: Stripe, our ledger, and OpenRouter must agree. Each invariant names the test that proves it.
Tests live in `ideas/ai-whiteboard/` and run in the existing CI loop (`for f in ideas/ai-whiteboard/*.test.js`).
Status: **proven** only when CI is green for that test. Nothing is proven by this document.

| # | Invariant | Proving test | Built in step | Status |
|---|---|---|---|---|
| I1 | Every AI call holds before it starts; open holds plus settled spend never exceed the balance | `ai-ledger.test.js` (incl. 20 parallel holds) | 1.2 | open |
| I2 | Every hold ends as settle, release, or a flag to Lilly; never dropped silently | `ai-ledger.test.js`, `ai-cleanup.test.js` | 1.2, 1.12 | open |
| I3 | Settled cost equals OpenRouter `usage.cost`, failed attempts included | `ai-openrouter.test.js`, `ai-run.test.js` | 1.7, 1.11 | partly (cost read: `ai-openrouter.test.js`) |
| I4 | Key limit is always `max(granted - deducted, usage)` | `ai-limit-rule.test.js` | 1.3 | written, unrun |
| I5 | A ticket allows at most two attempts, only for its person and ask hash | `ai-ticket.test.js` (pure), parallel SQL test | 1.5 | pure part written, unrun |
| I6 | No key, pass, or prompt text in logs, responses, `ai_usage`, or the browser | `ai-openrouter.test.js` (errors), `ai-outcome.test.js` | 1.7, 1.20 | partly |
| I7 | Browser reads its own balance and writes nothing | `supabase/tests/policy_tests.sql` | 1.1 | open |
| I8 | Every AI entry point reaches the AI only via `/route` then `/run` | no-missed-entry-point grep test | 1.15 | open |

Passing bar for the ICP (a non-technical dreamer): an ask never silently costs more than their balance, a failure never charges for nothing they got,
and everything the AI puts on the board stays theirs to edit (repo CLAUDE.md rule 1).
Phase 2 adds the Stripe invariants (invoice, refund, dispute rows) to this table.
