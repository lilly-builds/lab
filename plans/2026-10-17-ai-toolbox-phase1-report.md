# AI Magic Toolbox: phase 1 report (step 1.21)

Date: 2026-10-17. Branch `invisible-ai-toolbox` (PR #214), not merged. Everything below ran on this computer: a scratch Postgres 17 with the
real migrations, the real function handlers (also run once under Deno 2.7.12), the real board in Chromium, and a fake OpenRouter.
Nothing has touched the hosted Supabase project, a real OpenRouter key, or Stripe. Status: **locally verified**, not production verified.

## Checklist from the build plan, section 5 (mock stack)

| # | Check | Result |
|---|---|---|
| 1 | Create a tester pass; paste it once in the board | Pass. A wrong pass gets "That pass didn't work."; the right one connects and resumes the ask |
| 2 | First ask ever: an idea map lands; edit a branch, move a box, delete a line, undo | Pass. 5 notes and 4 arrows, placed by the normal draw code; a branch was dragged, retyped, an arrow deleted and undone, all saved |
| 3 | Second ask: normal result; "more detail on <thing>" works | Half. The second ask goes through the router to a normal answer. The follow-up needs session memory (1.17), skipped until gate G2 |
| 4 | Make it real, the app's Retry, Dream plan, Have-to loop, each once | Pass, all four in the browser |
| 5 | Force a cut-off: attempt 2 runs; two charges; both match the mock's costs | Pass (`ai-outcome.test.js`): the cut-off hold waits for cleanup, which settles it at the generation's cost |
| 6 | Force both attempts to fail: the ask stays in the box; the board says what happened | Pass: "The AI couldn't finish this twice in a row. Your ask is still here." |
| 7 | Stop mid-build: the hold settles (or is flagged); the balance is right | Pass: the app is removed, the idea goes back in the box, cleanup settled the hold at gate + partial build cost |
| 8 | Six builds at once with a small balance: later ones refused cleanly | Proven at the database (20 parallel holds, exactly 10 fit) and in `ai-route.test.js`; not clicked as six builds in the browser |
| 9 | Revoke the pass: next ask refused; the key (mock) disabled | Pass |
| 10 | Search logs and the database for the pass and the provisioned key | Pass for server logs and every AI table (`ai-outcome.test.js`). The pass lives in the browser's storage and travels as a header, by design; the provisioned key never leaves the server |
| 11 | Everything on the board produced by AI is selectable and editable | Pass for idea-map and draw notes and arrows, and Dream plan and have-to notes are ordinary notes. Built apps: Retry was tested; editing an app's idea text was not re-tested (that code is unchanged) |

## What only Lilly can do next (nothing done for these)

1. Phase 0 live runs: the model allowlist (step 0.5; the functions refuse the placeholder list), the safety-gate model (0.4), the long
   stream probe (0.6), and the OpenRouter mechanics probe (0.7): key create with a limit, limit update, `/generation` cost, the field names
   `models`, `provider.max_price`, `provider.zdr`, `reasoning.max_tokens`, `usage.cost`, `total_cost`. Until 0.7 passes they are unverified.
2. Deploy, in the order in `ideas/ai-whiteboard/supabase/README.md` (AI Magic Toolbox section): migrations, five secrets, six functions,
   the schedule, a first tester. Then check that the `cf-connecting-ip` header arrives (the per-address rate limit depends on it).
3. Fix CI's database job on main: the template seed inserts rows that `templates_reserved_slugs` refuses. Separate from this PR.
4. Flip `toolboxEnabled` when ready. Until then the live board is unchanged.

## Calls made during the build (each easy to change)

- The board-size cap is 100,000 characters, so the safety gate always reads the whole payload (a review found it read only the first
  8,000). A ticket lasts 15 minutes so a 5-minute build can still use its second attempt.
- The hold counts every UTF-8 byte as a token (always enough, in any language); a picture counts 5,000 tokens until phase 0 measures it.
- The per-address rate limit trusts only `cf-connecting-ip`; without it only the per-person limit applies.
- Next moves are built (the build plan has them) though the architecture lists them as "proposed, not yet approved".
  `AI_NEXT_MOVES=off` turns them off.
- The gate reads pictures itself ("native"). The describe-first fallback fails closed; it is not wired.
- Outcome logging records `undo` (within 2 minutes of an answer) and `nextmove_tap`. Edits, deletes and redos are not hooked yet.
- Typewriter hints: the second prompt is wider than the desktop ask box and gets cut off near "Get it done so I can"; the third is a
  temporary wording. Both are Lilly's call.
- All toolbox UI stays behind the switch. The own-key path (Anthropic, OpenAI) still works during phase 1 (build plan U2).
- Defaults from the plan still stand: first ask means first ask ever; 5 gate blocks in a day pause a person; 30 asks an hour per person,
  120 per address; a model failing over 10% of its last 50 calls is skipped; an unpriced hold is flagged after 10 minutes; a day's spend
  over $10 is flagged; one grant is capped at $50.
