# Dreamspace: next-phase plan

Status: clarified plan, ready for gap-resolution then bite-sized issues. Owner: Lilly. Written: Oct 12, 2026.

## Vision in one line

Ideas stop dying: you drop sticky notes on a board, and your team (background AI) picks them up - have-to's get done, want-to's get encouragement and motion, dreams get plans.

## Language and naming

- "Your team" = the background AI agents. Warmer than "agents"; the dream board is where you meet your team.
- The three loops map to the three circles, so every sticky that lands has somewhere to go. The board is an engine, not storage.
- Model strategy: fast model (haiku/luna) is the onboarding ramp, not the ceiling. First runs default fast so magic lands in under a minute; later the router picks model by task weight - quick wins stay instant, heavy builds get the strong model. (Shipped for Make it real as fast-default; task-weight routing is future work.)

## The 5 elements

1. First moment - dream board + sticky note dramatically slaps into the Have to do circle, pre-written ("Email the landlord about the leak"), teaching "write down your have-to's > the board gets them done." SHIPPED Oct 12 (PR #116).
2. Background agent loops that get things done (the 3 loops below - the actual product).
3. Add a template to the community board.
4. Invite a friend, cofounder, teammate, family to your board.
5. The open tool router.

## The 3 loops (core product)

- Loop 1 - have-to's: sticky drops > an agent picks it up and GETS IT DONE. Proactive and relentless about solving walls instead of reporting "here's a wall, I need your help."
- Loop 2 - want-to's: sticky drops > speech bubble from the team: "oooh tell me more. Let's make it happen." (or other fun responses). Enthusiastic, not a form letter.
- Loop 3 - dreams: sticky drops > speech bubble: "do you want to make a plan to make this dream real? your team can get it started, then we can collaborate until it fits your flow."

## Build order (decided)

Loop 3 first - it rides machinery that already exists (plan generation + Make it real). Cheapest loop, biggest magic. Loop 2 second - mostly copy and a bubble. Loop 1 last and scoped NARROW: one kind of have-to the agent truly completes end-to-end before widening; it is the highest promise and hardest build, so it must not overpromise. Invite and community-template-add wait until loops retain people - no point inviting into a board that doesn't do anything yet.

## Work items (each becomes one bite-sized issue; independently executable)

- W1 Loop 3 detection: when a note lands inside the Dream circle, classify it as a dream (fast model) and trigger the dream flow. Acceptance: note in circle > bubble appears in under ~3s on a connected key; notes outside circles unaffected. Depends on: none.
- W2 Dream speech bubble UI: the team's bubble appears anchored to the dream note with her line ("do you want to make a plan to make this dream real? your team can get it started, then we can collaborate until it fits your flow.") with Yes / Not now. Acceptance: Yes continues to W3; Not now dismisses and does not re-ask for that note. Depends on: W1.
- W3 Dream plan generation: on Yes, the team drafts a plan (goal, milestones, first actions) onto the board as connected notes near the dream, then offers Make it real on the first action. Acceptance: plan notes appear editable/deletable; one tap starts a build. Depends on: W2.
- W4 Loop 2: note in Want to do circle > speech bubble "oooh tell me more. Let's make it happen." with a small rotating set of fun variants. Acceptance: variants rotate, never repeats back-to-back; bubble dismisses politely. Depends on: none (can parallel W1-W3).
- W5 Loop 1, narrow scope: ONE have-to type the agent completes end-to-end (candidate: research-and-answer - the team goes off, comes back with the answer written on the board). Relentless wall-solving: on a blocker it tries alternate routes before surfacing anything. Acceptance: the chosen have-to completes with zero user involvement in the common case; failure states written as the team's progress notes, not "I need your help." Depends on: scope decision (gap G1), W1's detection pattern.
- W6 Task-weight model routing: router chooses fast vs main model by classified task weight; fast stays default for first runs. Acceptance: quick asks stay under a minute; heavy builds get the strong model without user setup. Depends on: W1-W3 stable.
- W7 Invite flow polish: friend opens the shared board link and lands on a welcoming first view (not the seed moment). Acceptance: invited viewer understands the board in 10 seconds. Depends on: loops visible enough to be worth sharing.
- W8 Add-template-to-community flow smoothing: from "Share as template" to published with the least friction that keeps gallery quality. Acceptance: a new template goes from board to gallery in one sitting. Depends on: W7.
- W9 Open tool router: swappable route table surfaced so new tools/agent skills can be added as routes. Acceptance: adding a tool is a data-entry change, documented. Depends on: W6.

## Issue-flow mechanics (compound-engineering informed)

- One bite per issue; each issue carries everything a fresh coding agent needs (context, acceptance criteria, constraints) - no transcript required (the CE "session handoff" principle).
- Durable artifacts over chat: this plan is the source of truth; decisions get appended here, not left in messages.
- After each shipped bite, capture what broke or what convention emerged as a short Learnings entry (plans/learnings.md) so later issues get easier (compound the knowledge).
- Feel/look decisions get tried as throwaway experience prototypes before they are encoded, not debated abstractly (CE brainstorm stage).

## Open judgment gaps (owner calls needed before build)

See G1-G8 - tracked with the conversation, resolved answers get appended here.
