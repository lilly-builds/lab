# Invisible AI Toolbox: experience brief (DRAFT)

Status: interview about half done, last updated 2026-10-14 around 3:40 PM PDT. Not reviewed yet. No code written.
No building until Remember stuff is verified and the live-board freeze is lifted.
Diagram: https://claude.ai/artifact/Nk153vwTLu693xr8RRWXoe (private)

## Decided so far

1. The first ask lands as an idea map: one center note with connected branch notes. Every box and line is editable.
2. When the ask box is empty, hint text types itself out letter by letter. It pauses, erases, types the next prompt, and loops.
   It stops the moment someone clicks in. Blanks show as ___.
   - "My biggest dream is ___. Help me make it real."
   - "I have to do ___ today. Get it done so I can focus on building my dream."
   - "I want to design today to be an adventure where we ..." (Lilly to finish this one)
3. "Open router" means one gateway that plugs into many AI tools, with our own rules for which AI runs when.
   Build it ourselves. Lilly prefers build over buy unless building is uneconomical or a free open-source tool fits.
4. MVP jobs are chat and code. Image and video come later.
5. Quality first, then speed. Each job gets an AI good enough that the answer never feels dumb.
   Then we make that AI run as fast as it can. CHANGED 3:38 PM: this replaces the old "first ask runs on the fast AI" rule
   from the Monday vision. Speed never comes from swapping in a weaker AI.
6. The rulebook is the core of the system (Lilly agreed it's the highest-leverage piece).
7. Key setup is the biggest bottleneck for the audience (Lilly agreed).
   Direction: bring-your-own-key, with the board guiding people to a key, not the "we provide the key and sell credits" (Higgsfield) model.
   Proposed, not approved: front door is a one-click "Connect OpenRouter" button (OpenRouter's OAuth PKCE flow returns a key
   with no copy-paste). Side door is pasting an Anthropic or OpenAI key, with a scripted guide that needs no AI.
   It asks one or two questions, opens the right page, explains that a ChatGPT or Claude subscription isn't an API key,
   detects which company a pasted key belongs to, and tests it.
   VERIFIED in code: after a key is saved, the board re-sends whatever is in the ask box, so their dream survives the detour.
   UNVERIFIED: whether OpenRouter's code exchange works from a browser-only page (CORS), and whether new accounts get any free credit.
   Remaining bounce point either way: people still add a card at the AI company.
8. OpenRouter first (Lilly, ~4:00 PM). Checked in OpenRouter's docs:
   - Per-request routing works with anyone's key: a `models` list (first choice plus backups), `provider.sort`
     ("throughput" or "latency" covers the speed rule; ":nitro" is the shortcut), and `data_collection: "deny"` for privacy.
   - Presets save a rulebook in OpenRouter's dashboard. They look tied to the account that made them,
     so they probably won't work with people's own keys. UNVERIFIED.
   - Merchant option: one OpenRouter account (ours). A management key on our server piece creates a key per person with
     a credit `limit` that resets daily/weekly/monthly (`limit_reset`), shows usage per key, and can disable keys.
     The docs list "unique API keys for each customer" for SaaS apps as a use case. No way found to create OpenRouter
     accounts for people. The management key must never reach a browser. Read OpenRouter's terms before charging anyone.
   Proposed, not approved: keep the rulebook in our code and send those instructions with each request, so the brain
   isn't locked inside OpenRouter. Start with Connect OpenRouter. The merchant model can slot in later, because only
   the source of the key changes.
9. DECIDED (Lilly): we provision the key (merchant model). No "do you have OpenRouter?" question, since our audience
   doesn't know what OpenRouter is. Bring-your-own-key stays as a small side link for power users.
10. Phase 1 is concierge: Lilly hand-makes capped keys in her OpenRouter dashboard for the first testers, and each tester
    pastes theirs once (about 4 steps). No server, no Stripe. Phase 2 automates it: server piece, sign-in, Stripe Checkout,
    credits tally. UNVERIFIED: that the dashboard lets you set a cap when making a key.
11. Money is Tier 4 and gets triple-checked. Three independent records have to agree for every purchase:
    Stripe (they paid), our credits tally (we granted it), and OpenRouter (the key's cap went up).
    A daily check flags any mismatch to Lilly. It never fixes money on its own.
12. "Your key stays on your device" was inherited from today's app. It is NOT a rule for this feature (Lilly).
    Proposed, not approved: every OpenRouter key lives on our server, and every AI call goes through it.
    Each person still gets their own capped key, but only the server uses it. That keeps OpenRouter's cap as the third money record.
    Why: OpenRouter's terms ban "reselling API access to Models" (§7). A key in a browser can be copied out and used
    anywhere, which looks like that.
    CORRECTION to item 10: handing testers raw keys has the same problem. Phase 1 needs a tiny server piece too
    (holds Lilly's key, passes calls through, caps each tester), just without Stripe. The other route is
    OpenRouter's written OK. The tiny server piece is the same one phase 2 needs, so it isn't wasted work.
    App copy to change when the merchant version ships (true today, don't touch yet): index.html:325
    "Your key stays on this device." and index.html:4002 "...it never leaves your device."
13. Lilly wants the rulebook to weigh how hard each ask is. How it decides is under discussion.
    Proposed: the router call that already runs on every ask (index.html:2223-2243, picks the job) also returns
    easy/medium/hard. NOT BUILT: today it only picks the job. A generic "Go deeper" button was REJECTED by Lilly
    as too generic. Proposed instead: after each result, the AI offers 2-3 specific next moves tied to what it made
    (e.g. "Price out supplies", "Turn this into a 30-day plan"). Each tap gets rated like any other ask.
13a. Router pillars. End state (Lilly): live-updating logic for which models and tools fit each task. We don't start there.
    Lilly named: (1) kind of task (writing goes to a chat model, coding goes to a coding-strong model), (2) how hard / how much
    reasoning, (3) draft or polish (prototype wording and early rounds favor speed; later rounds favor quality).
    Proposed additions, full chart at https://claude.ai/artifact/Nk153vwTLu693xr8RRWXoe#router-weighs :
    MVP: what it's looking at (images, files, how much board), shape of the answer, creative or precise, same voice for follow-ups,
    who's asking (plan, credits, language), is it allowed (safety gate), right-now conditions (backups now, self-updating later),
    how it went (log redo/undo/edit/next-move taps from day one).
    Later: needs fresh info (OpenRouter web search tool), needs to do things (tools plus approval), cost of being wrong.
    Design: one quick router call answers most clues at once. The rest are facts the board already has.
    Knobs it can turn: which AI, thinking effort (OpenRouter `reasoning.effort`), speed sort, how adventurous the wording is,
    answer length, web search on/off. https://openrouter.ai/docs/api_reference/parameters ,
    https://openrouter.ai/docs/guides/features/server-tools/web-search
13b. Conversation memory. VERIFIED today (index.html:488, 550): every AI call is a brand-new one-message conversation.
    The AI gets the ask plus the board (a text list of everything on it, and a picture for idea maps), so the board
    is the only memory. The one exception: a clarifying question's answer gets stitched to the original ask (index.html:2250-2257).
    So "make it more detailed" only works if the AI can tell "it" from the board alone.
    Proposed for MVP: (a) short session memory, meaning the last few asks and what each did, sent with each new ask;
    (b) everything the AI makes remembers the ask that made it (apps already store their prompt as el.prompt, index.html:3543).
    Later, not MVP: long-term memory across sessions ("remembers you're starting a candle business"), which needs server storage
    and its own privacy rules. OPEN: is "Remember stuff" (the work that finishes first) PR #171's board saving, or AI memory?
    If it's AI memory, this overlaps and should line up with it.
14. DECIDED: the server holds every key, and every AI call goes through it. The spec must spell out security
    explicitly: "really safe from attack" (Lilly).
15. DECIDED: a light free plan, with very low spend (unfunded). People earn more credits when they invite a friend
    AND they actually collaborate on a board together. The spec defines "actually collaborate" so it can't be faked
    with throwaway accounts.
16. DECIDED: US only at launch.
17. DECIDED: a monthly plan (recurring revenue). This brings auto-renewal rules (clear opt-in, online cancel via
    Stripe's hosted customer portal, renewal reminders), and the spec covers them.
18. DECIDED: people keep unused credits. Refunds follow the common SaaS pattern (proposed: cancel anytime, keep access
    until the paid month ends, no partial-month refunds, billing mistakes always refunded). A lawyer should confirm.
    Since people paid up front, top up OpenRouter only as credits get spent, so its 365-day credit expiry never costs us.
19. DECIDED: zero data retention on. Long-term direction: open models. OpenRouter's public model list (fetched
    2026-10-14): 462 models, 171 with open weights (top makers: Qwen 29, DeepSeek 15, Z.ai/GLM 14, Mistral 13,
    NVIDIA 10, Moonshot/Kimi 8, Meta Llama 8, Google Gemma 8). 135 of those 171 have at least one zero-retention endpoint.
    Example prices per million tokens in/out: GLM 5.3 Flash $0.15/$0.50, Qwen 3.8 Flash $0.15/$0.47,
    DeepSeek V4.1 Flash $0.02/$0.89. For comparison: Claude Sonnet 5.5 $2/$10, Claude Haiku 5.5 $0.10/$0.50.
    Open models still have to pass the quality-first rule, so test idea maps on them before relying on them.
20. Pricing math: OpenRouter's 5.5% fee ($0.80 minimum) applies only when we buy credits. Model prices pass through
    with no markup (OpenRouter FAQ). Every response includes `usage.cost`, the exact charge, always on
    (https://openrouter.ai/docs/use-cases/usage-accounting). So we bill each person's exact cost times one multiplier
    that covers OpenRouter's 5.5%, Stripe's fees, server costs, and margin. Top up OpenRouter $15 or more at a time
    so the $0.80 minimum doesn't bite. UNVERIFIED: exact Stripe card and subscription fee rates.
16b. DECIDED: 18+ only (Lilly). This is a contract requirement, not one single law: OpenRouter's terms (§2) and Gemini's terms
    (no apps likely used by under-18s). Laws: COPPA covers under-13s if a site is child-directed or knows it has their data,
    and Colorado HB26-1263 adds minor protections from Jan 1, 2027.
    DECIDED (Lilly): NO age question at sign-up. "If we get in trouble, we fix it."
    Spec: 18+ in the terms. Proposed, not approved: one line of sign-up text, "By continuing you agree to the Terms and confirm
    you're 18 or older" (no extra click). If we learn an account belongs to someone under 18, close it and delete their data.
    Open for a lawyer: whether Colorado HB26-1263's "estimate users' ages" duty applies to the board.
20b. Open vs frontier models, shown to users? Proposed, not approved: no upfront choice, since the audience doesn't know the
    difference and a choice breaks "nobody has to pick a model". If tests show open models make good idea maps,
    "open by default" becomes part of the story (a trust line, not a setting), and frontier models step in only where
    they're clearly better. The "why this AI?" peek shows which. Later, not MVP: an "only use open models" setting for people
    who care. Copy note: most are open-weight, not fully open source, so user copy says "open models" and never claims "open source".
21. AI disclosure: onboarding already says it (Lilly). The spec checks that its wording and placement meet
    Anthropic's policy ("at the beginning of each chat session or in the product interface") and EU Article 50.

## Research: OpenRouter terms and mechanics (2026-10-14, verified unless marked)

- Building AI into your own product is allowed (terms §5.1). Reselling raw model access is banned (§7). https://openrouter.ai/terms
- We're responsible for everything our users do (§5.2). Jailbreaking counts as our violation (§7, §8).
  A violation ends access automatically, and unused credits are not refunded (§9). OpenRouter can also terminate for no reason.
- Users must be 18+ (§2). Gemini's terms also require 18+. https://ai.google.dev/gemini-api/terms
- Send a hashed per-person ID in the `user` field, or else one bad user's upstream block hits everyone.
  https://openrouter.ai/docs/cookbook/administration/user-tracking
- `POST /api/v1/end-users` only registers an ID. It creates no account and blocks nothing.
- Fees: 5.5% per card purchase ($0.80 minimum). $5 minimum purchase. Refunds only within 24 hours, and fees are never refunded.
  Credits may expire 365 days after purchase. Auto top-up exists. https://openrouter.ai/docs/faq and terms §4
- Rate limits are account-wide. More keys don't add capacity. https://openrouter.ai/docs/api-reference/limits
- OpenRouter doesn't store prompts unless we opt in. `data_collection: "deny"` and `zdr: true` restrict which providers we use.
- Anthropic, from Nov 12, 2026: chat products must tell people they're talking to AI. https://www.anthropic.com/legal/aup
- Browsers can call OpenRouter directly (CORS open), but see item 12 for why we shouldn't.
- UNVERIFIED: whether presets and guardrails work on keys made through the management API (one test call would settle it).
- Decision for Lilly: get written confirmation from OpenRouter support that our setup counts as building it into our product.
  Selling "board credits" priced per feature reads safer than reselling model credits dollar for dollar.

## Recommended architecture (proposed, Lilly has not approved it)

- Rulebook: build it in the browser as one table. Columns are the job, the first-choice AI, and a backup AI.
  It grows out of today's job list (the ROUTES table), not a new system.
  It can pick the best AI the person's key can reach, so one key from any company works for every job.
- Speed: comes from how we run each AI, never from a weaker AI. Ideas to check: show results on the board as they arrive,
  send the AI less board data, and keep instructions short. UNVERIFIED: which jobs already stream results today.
- Plug: add one generic OpenAI-compatible translator next to today's Anthropic and OpenAI ones.
  It covers OpenRouter and other compatible companies. UNVERIFIED: which companies allow direct calls from a browser.
- OpenRouter: an optional supplier, not the brain. UNVERIFIED: exact fees. Their FAQ says there's a fee on credit purchases,
  and bring-your-own-key is free up to a monthly allowance, then charges a fee.
- Self-hosted open-source gateways (LiteLLM, Bifrost, Portkey): skip for the MVP. Each needs a server running all day.
  Our own small server piece does the job we need.
- Tradeoff to watch: a smarter AI usually means a longer first wait, so what "your team" shows while it works matters more.

## Today vs desired

Today (verified by reading ideas/ai-whiteboard/index.html on main at 59f0d07):
- One ask box. A fast AI sorts each ask into one of 3 jobs (the ROUTES table: draw, edit, build).
- When it's unsure, it asks one clarifying question.
- Keys: Anthropic or OpenAI. The key is stored on the device and requested on the first send.
- Busy phrases like "Looking at your board" show while it works.
- If the router returns junk, the ask goes to draw. There's a 60-second timeout per step.

Desired: a rulebook with backups, a generic translator, OpenRouter as an option, the typewriter hints,
a quality idea map on the first ask, a visible "your team", approval before spending, and key setup for people who have no key.

## More key options found (not decided)

- Sign in with ChatGPT, plan usage: launched Sept 29, 2026. ChatGPT Plus and Pro subscribers spend their existing plan
  allowance in other apps, no API key needed. Commercial apps need OpenAI approval (limited trial); per OpenAI's quickstart,
  open-source apps can use it now. The lab repo is public but has NO LICENSE, so it isn't open source yet.
  Adding a license is Lilly's call. UNVERIFIED: whether a license alone qualifies us.
- Gemini key from Google AI Studio: needs only a Google account, and reportedly no card for the free tier.
  Sources conflict (some models need billing), limits aren't published, and free-tier data may be used by Google.
  UNVERIFIED: browser calls, and which strong models are free.
- Puter.js "user pays": one script tag. Users sign into Puter and pay from their own Puter account, so it costs us nothing.
  It covers Claude, GPT, and Gemini. All claims come from Puter's own site, so it's UNVERIFIED and adds a dependency on a small company.
- A capped free taste: the first idea map runs on our key through a small server piece with a hard daily budget,
  then the person connects their own. Needs the server piece and bot protection.
- Bigger bet, not MVP: the board as an app inside ChatGPT or Claude.

Estimated steps to the first idea map for a brand-new person (one click or one thing typed = a step; ESTIMATES,
no accounts were created to test them): free first idea map on us 2-3, we provide the key 4-5, Sign in with ChatGPT 5-8
(Plus/Pro only), Puter 7-9, Gemini free key 12-18, Connect OpenRouter 13-15, guided Anthropic/OpenAI paste 24-26,
today 26-30. Only paying-for-them paths get under 6. Every path that needs a card is 13+.
What the numbers suggest: the first idea map is on us, then the second ask offers the shortest path that person qualifies for.
Step-by-step lists: https://claude.ai/artifact/Nk153vwTLu693xr8RRWXoe#key-steps

## Research: payments and prepaid credits (2026-10-14, verified unless marked; not legal advice)

- Stripe works. Credits that only work inside our app are on the allowed side of Stripe's rules ("resale of a service
  without added benefit" is restricted). https://stripe.com/legal/restricted-businesses
- Simplest setup: fixed credit packs as one-time Stripe Checkout payments, with balances kept in our own database.
  Stripe's built-in billing credits only work with metered subscriptions.
  https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits
- Grant credits on `checkout.session.completed` or `checkout.session.async_payment_succeeded`, after checking `payment_status`.
  Verify the `Stripe-Signature` header against the raw body, log event IDs so a resent event is skipped, and expect
  events out of order. https://docs.stripe.com/checkout/fulfillment.md?payment-ui=stripe-hosted , https://docs.stripe.com/webhooks
- Tax: Stripe Tax is 0.5% per transaction where registered; filing help starts at $90/month. https://stripe.com/tax/pricing
  EU VAT can be owed from the first sale for non-EU sellers, and the UK has no threshold either. US state rules vary
  (counts UNVERIFIED). Stripe Managed Payments is Stripe acting as merchant of record (tax in 80+ countries, fraud,
  disputes), and AI products are eligible. Price, and whether credit packs pass review: UNVERIFIED.
  https://docs.stripe.com/payments/managed-payments/eligibility
- Paddle bans stored value and store credit. Polar puts AI content tools under closer review.
- Prepaid credits: never market them as gifts (federal gift-card rules exempt reloadable credit not sold as a gift card).
  California bans expiration dates on gift certificates. Whether app credits count as gift certificates: UNVERIFIED.
  Federal money-transmission rules exclude single-merchant prepaid value up to $2,000 per account per day.
  Keep credits non-cashable, non-transferable, and capped well under that.
  https://www.fincen.gov/resources/statutes-regulations/guidance/frequently-asked-questions-regarding-prepaid-access
- Disputes cost $15, plus $15 more to contest (refunded if we win). Customers have about 120 days to dispute.
  Put the refund policy in the terms, require a checkbox at checkout, and use a recognizable name on card statements.
- A monthly plan pulls in auto-renewal laws (California: clear opt-in kept 3 years, online cancel, yearly reminders).
  One-time packs avoid that.
- Confirm with professionals: a lawyer on credit expiry and gift-certificate status, and on OpenRouter's terms vs our setup.
  An accountant on sales tax/VAT and unclaimed-property reporting.
- Lilly's decisions: packs vs monthly plan, credit expiry, Stripe + Stripe Tax vs Stripe Managed Payments, US-first vs worldwide,
  refund policy for unused credits, free starter allowance size, max balance per account.

## Research: server build, abuse, privacy (2026-10-14, verified unless marked; not legal advice)

Architecture (both researchers agree): every AI call goes through a Supabase Edge Function. Each person gets one capped
OpenRouter key that only the server uses. Optional OpenRouter guardrails per key (model allowlist, zero data retention, budget)
act as a backstop. https://openrouter.ai/docs/guides/features/guardrails
- Secrets via `supabase secrets set`, read with `Deno.env.get`. https://supabase.com/docs/guides/functions/secrets
- Caller check: keep `verify_jwt` on, and refuse anonymous sessions via the `is_anonymous` claim.
  https://supabase.com/docs/guides/functions/auth , https://supabase.com/docs/guides/auth/auth-anonymous
- Stripe webhook: its own function with `verify_jwt=false`, signature checked on the raw body. Stripe retries up to 3 days, out of order.
  Design: a unique Checkout Session ID per ledger row, then set the key's limit to the ledger total, so a retry can't double-credit.
  UNVERIFIED: the exact PATCH /api/v1/keys/{hash} limit field (the doc page 404'd).
- Credits are completely separate from juice points (Lilly). Juice is a gamified reward system, and there's no link between them.
  Credits get their own per-user table that only the server can write. (For the record, `juice_events` couldn't hold money anyway:
  it's tied to a board, and `import_board` lets the browser set any balance, PR #171 rls.sql:129, 184-187.)
- Edge Function limits: 150s idle timeout, 150s run time on free (400s paid), 2s CPU. https://supabase.com/docs/guides/functions/limits
  UNVERIFIED: whether streaming resets the idle timer, so long builds might get cut off. Needs a test.
- Cost: 500k free invocations, then $2 per million. Both of today's AI call paths (index.html:448, 510, 528) get rewritten.
- Abuse: Turnstile CAPTCHA is free and supported by Supabase Auth. No free credits for anonymous guests.
  Starter credits only after a confirmed email, once per email.

Blockers in PR #171 before paid credits can turn on:
1. Sign-in only exists when sync is on (sync.js:45, 193; auth.js:28). The returning-device data-loss bug was reportedly
   addressed in an earlier PR #171 commit (per Codex, 2026-10-14). An independent review is still checking whether every
   board-wipe path is gone, so treat it as UNCONFIRMED until that review lands. Separating sign-in from sync is still worth weighing.
2. Hosted Auth site URL is still localhost, so sign-in links fail.
3. CAPTCHA is off (config.toml:18-21). UNVERIFIED: sync.js:193 signs in anonymously without a CAPTCHA token, so it may break when CAPTCHA turns on.
4. The free Supabase plan has no backups and pauses after 7 days of low activity. Payment records need Pro.
5. Built-in email sends only 2 per hour, so we need our own email sender (custom SMTP).

Privacy and safety:
- Privacy policy names Supabase, OpenRouter, each model provider, Stripe, and Cloudflare. OpenRouter keeps no prompts by default,
  doesn't train on inputs, and can force zero data retention account-wide.
- Age: 18+ terms plus an age question at sign-up is the simplest path (OpenRouter §2, Gemini terms).
- AI disclosure: EU AI Act Article 50 (in force Aug 2, 2026), Anthropic's policy (Nov 12, 2026), and Colorado HB26-1263
  (Jan 1, 2027: disclose AI, estimate ages, no engagement rewards for known minors). The minors part may touch the juice
  points feature, which is separate from credits, so flag it to whoever owns juice.
  https://artificialintelligenceact.eu/article/50/ , https://leg.colorado.gov/bills/hb26-1263
- GDPR applies if we serve EU users at all. Decision: serve or block the EU.

Prerequisite outside this feature (Lilly, 2026-10-14): check whether Supabase is the right database before building more on it.
That's the database track's job, not this one's. Lilly is fine with a small server cost. Meanwhile, keep the toolbox's server
piece portable. It only needs secret storage, a signed-in-user check, a webhook endpoint, and a credits table with a unique purchase ID.

For a lawyer: whether our setup fits OpenRouter's terms, credit expiry and gift-certificate rules, whether the EU AI Act
and Colorado HB26-1263 apply to the board, and the privacy policy. For an accountant: sales tax/VAT and unclaimed property.

## Still open (interview continues)

1. How someone with no key gets started, and what they should expect to pay. (Next.)
2. How the rulebook judges how hard an ask is (Lilly wants it weighed). Options are under discussion.
3. How visible routing is: fully invisible, or can people see "why this AI?"
4. What "your team" shows while it works.
5. Approval before it spends money or takes outside actions.
6. What the person sees when a tool fails.
7. The wording of the third typewriter prompt.

## Draft first-use flow

1. Someone opens the board. The ask box is typing out a dream prompt.
2. They type "My biggest dream is opening a candle shop. Help me make it real."
3. Key setup appears. Today that means pasting an Anthropic or OpenAI key. How this should work later is still open.
4. The AI picked for idea maps starts putting the map on the board: a center note plus branches.
5. They drag, edit, and grow the notes.
6. Later asks go to chat or build, each on the AI the rulebook picks, with a backup.

## Draft passing criteria (what makes this great for the person using it)

- The idea map is good enough that it doesn't feel dumb, and the wait is as short as that AI allows.
  A seconds target gets set after timing it.
- Every note and line in that idea map can be edited, moved, and deleted (repo rule: nothing is static).
- The typewriter hint stops the moment the person clicks in and never ends up in what they send.
- If the first-choice AI fails, the backup runs and the person gets a result without retyping.
- No OpenRouter key ever reaches a browser. No key shows up in commits, logs, or shared links.
- Nobody has to pick a model or a job to get a result.
- Money, phase 1: every tester key has a cap, and auto top-up on the OpenRouter account is off,
  so the most Lilly can lose is her prepaid balance.
- Money, phase 2: for every purchase, Stripe, our credits tally, and the OpenRouter key cap all agree.
  Paying once never grants credits twice, even when Stripe resends the same payment notice.
  A failed or refunded payment never leaves credits behind. All of it gets proven end to end in Stripe's test mode
  before any real card is charged.

## How we build (from Lilly's Desktop builder manifesto)

Plan with /ce-plan, review the plan with /ce-doc-review, build with /ce-work, and review the code with /ce-code-review
plus a second agent acting as an adversarial reviewer. Unit and integration tests, then an agent tries it like a user.
The manifesto names /ce-build, but that skill doesn't exist, so /ce-work takes its place.
The manifesto's #2 tracking template is blank in the file, so we still need it from Lilly.
Lilly pointed to the Desktop manifesto, not restoreops/docs/BUILDER-MANIFESTO.md, so the RestoreOps-only parts don't apply.

## Constraints

Work stays in the invisible-ai-toolbox worktree. No edits to main, no merges, no deploys, and the live-board freeze stays.
No secrets in chat, commits, or shared links. No account connections or purchases.

## Sources

- OpenRouter FAQ: https://openrouter.ai/docs/faq.mdx
- OpenRouter pricing: https://openrouter.ai/pricing
- Arch-Router paper: https://arxiv.org/html/2506.16655v1
- archgw routing docs: https://docs.archgw.com/guides/llm_router.html
- RouteLLM: https://lmsys.org/blog/2024-07-01-routellm/
- Open-source gateway roundup (written by Bifrost's maker): https://getmaxim.ai/articles/top-5-open-source-llm-gateways-compared-2026/
