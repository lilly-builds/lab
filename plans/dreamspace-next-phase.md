# Dreamspace: next-phase plan

Status: clarified plan, ready for gap-resolution then bite-sized issues. Owner: Lilly. Written: Oct 12, 2026. Updated Oct 12: sticky note juice added at elevated priority.

> **Locked vocabulary (set by the owner, Oct 12, 2026).** These names are locked: the 4 elements (Magic Moment, Community Template Shares, Collab Together, The Invisible AI Toolbox) and the 3 loops (Have to loop, Want to loop, Dream big loop). Use them exactly in issues, code comments, and copy. W-numbers and G-gap IDs stay stable so history still reads.

## Vision in one line

Ideas stop dying: you drop sticky notes on a board, and your team (background AI) picks them up - have-to's get done (Have to loop), want-to's get encouragement and motion (Want to loop), dreams get plans (Dream big loop).

## Language and naming

- "Your team" = the background AI agents. Warmer than "agents"; the dream board is where you meet your team.
- The three loops (Have to loop, Want to loop, Dream big loop) map to the three circles, so every sticky that lands has somewhere to go. The board is an engine, not storage.
- Model strategy: fast model (haiku/luna) is the onboarding ramp, not the ceiling. First runs default fast so magic lands in under a minute; later the router picks model by task weight - quick wins stay instant, heavy builds get the strong model. (Shipped for Make it real as fast-default; task-weight routing is future work, under The Invisible AI Toolbox.)

## The 4 elements

The old "background agent loops" element is cut as an element: it IS the loops (next section).

1. Magic Moment - the onboarding / dream board first moment: dream board + sticky note dramatically slaps into the Have to do circle, pre-written ("Email the landlord about the leak"), teaching "write down your have-to's > the board gets them done." SHIPPED Oct 12 (PR #116).
2. Community Template Shares - add a template to the community board.
3. Join my Dream Team - invite a friend, cofounder, teammate, family to your board.
4. The Invisible AI Toolbox - the open tool router.

Plus, elevated priority by owner: the visible success loop - STICKY NOTE JUICE (below).

## The 3 loops (core product)

- Have to loop (have-to's): sticky drops > the team picks it up and GETS IT DONE. Proactive and relentless about solving walls instead of reporting "here's a wall, I need your help."
- Want to loop (want-to's): sticky drops > speech bubble from the team: "oooh tell me more. Let's make it happen." (or other fun responses). Enthusiastic, not a form letter.
- Dream big loop (dreams): sticky drops > speech bubble: "Do you want to make a plan to make this dream real? Your team can get it started."

## Sticky note juice (success loop)

The visible reward that reinforces dream building. You earn juice when YOUR TEAM completes a have-to, and when YOU complete a want-to yourself. Completing a dream pays 10x. Juice accumulates on your board as a meter - funny, tangible, a little ridiculous on purpose.

Leaderboard: longer-term. Shines once boards have teams and friends on them - juice compared across people on a shared board. Do not build before invites exist.

## Build order (decided)

Dream big loop first - it rides machinery that already exists (plan generation + Make it real). Cheapest loop, biggest magic. Want to loop second - mostly copy and a bubble. Juice meter third - it needs loop completions to count, but its UI can start as soon as the Dream big loop lands. Have to loop last and scoped NARROW: one kind of have-to the agent truly completes end-to-end before widening; it is the highest promise and hardest build, so it must not overpromise. Collab Together and Community Template Shares wait until loops retain people - no point inviting into a board that doesn't do anything yet. Leaderboard after invites.

## Work items (each becomes one bite-sized issue; independently executable)

- W1 Dream big loop detection: when a note lands inside the Dream circle, classify it as a dream (fast model) and trigger the dream flow. Acceptance: note in circle > bubble appears in under ~3s on a connected key; notes outside circles unaffected. Depends on: none.
- W2 Dream speech bubble UI: the team's bubble appears anchored to the dream note with her line ("Do you want to make a plan to make this dream real? Your team can get it started.") with Yes / Not now. Acceptance: Yes continues to W3; Not now dismisses and does not re-ask for that note. Depends on: W1.
- W3 Dream plan generation: on Yes, the team drafts a plan (goal, milestones, first actions) onto the board as connected notes near the dream, then offers Make it real on the first action. Acceptance: plan notes appear editable/deletable; one tap starts a build. Depends on: W2.
- W4 Want to loop: note in Want to do circle > speech bubble "oooh tell me more. Let's make it happen." with a small rotating set of fun variants. Acceptance: variants rotate, never repeats back-to-back; bubble dismisses politely. Depends on: none (can parallel W1-W3).
- W5 Juice meter v1: a visible meter on the board that fills as juice is earned. v1 earns from manual completions (marking a have-to done after the team finishes, marking your own want-to done) and dream completions at 10x. Acceptance: meter persists across reloads (localStorage), earning moment has a small celebration, meter never blocks board use. Depends on: W2 (completion signals), gap answers G5-G7.
- W6 Have to loop, narrow scope: ONE have-to type the agent completes end-to-end (candidate: research-and-answer - the team goes off, comes back with the answer written on the board). Relentless wall-solving: on a blocker it tries alternate routes before surfacing anything. Acceptance: the chosen have-to completes with zero user involvement in the common case; failure states written as the team's progress notes, not "I need your help." Depends on: scope decision (gap G1), W1's detection pattern.
- W7 Task-weight model routing: router chooses fast vs main model by classified task weight; fast stays default for first runs. Acceptance: quick asks stay under a minute; heavy builds get the strong model without user setup. Depends on: W1-W3 stable.
- W8 Collab Together, invite flow polish: friend opens the shared board link and lands on a welcoming first view (not the seed moment). Acceptance: invited viewer understands the board in 10 seconds. Depends on: loops visible enough to be worth sharing.
- W9 Community Template Shares, add-template flow smoothing: from "Share as template" to published with the least friction that keeps gallery quality. Acceptance: a new template goes from board to gallery in one sitting. Depends on: W8.
- W10 Leaderboard: juice compared across people on a shared board. Acceptance: per-board standings, opt-in display name. Depends on: W8 (people on shared boards), W5.
- W11 The Invisible AI Toolbox (open tool router): swappable route table surfaced so new tools/agent skills can be added as routes. Acceptance: adding a tool is a data-entry change, documented. Depends on: W7.

## Issue-flow mechanics (compound-engineering informed)

- One bite per issue; each issue carries everything a fresh coding agent needs (context, acceptance criteria, constraints) - no transcript required (the CE "session handoff" principle).
- Durable artifacts over chat: this plan is the source of truth; decisions get appended here, not left in messages.
- After each shipped bite, capture what broke or what convention emerged as a short Learnings entry (plans/learnings.md) so later issues get easier (compound the knowledge).
- Feel/look decisions get tried as throwaway experience prototypes before they are encoded, not debated abstractly (CE brainstorm stage).

## Open judgment gaps (owner calls needed before build)

- G1 Have to loop scope: which ONE have-to does the team complete first, end to end? (Candidate: research-and-answer.) What is off-limits for the team to do on its own?
- G2 Bubble personality: does "your team" have a face or name, or is it a voice from the board? How weird can the want-to's variants get?
- G3 Dream plan shape: when the team drafts a dream plan, does it land as sticky notes on the board, a threaded conversation, or its own zone?
- G4 Completion ritual: when the team finishes a have-to, what happens to the note - stamped done, flies off, changes color? Quiet or confetti?
- G5 Juice meter home: where does the meter live - corner of the board, above the toolbar, its own tab? Always visible or peek?
- G6 Juice look: what IS juice visually - droplet meter, battery, goo tank, squeeze bottle? Fill animation on earn?
- G7 Juice economy: base value of a have-to and a want-to (dream = 10x what?), and does juice DO anything (unlock themes, purely bragging rights)?
- G8 Leaderboard shape (later): per-board or global, real names or silly aliases, and is low-juice shaming in or out?
