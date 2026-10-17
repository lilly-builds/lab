// THIS FILE IS FOR: the rulebook (architecture 4.2). Pure table: job + clues + payload -> which models and budgets.
// No AI calls, no network. Every number below is a PLACEHOLDER until phase 0 step 0.5 measures it live.
import { readFileSync } from 'node:fs';

export const ALLOWLIST = JSON.parse(readFileSync(new URL('./allowlist.json', import.meta.url), 'utf8'));

// THIS SECTION IS FOR: the table. tier is the preferred model tier; hard asks move up to frontier where allowed.
// maxPrice is dollars per million tokens (prompt / completion), always set so a call has a worst case.
// build keeps its 9000-token answer (index.html buildApp); thinking is added on top, never carved out of it.
export const ROWS = {
  router:    { tier: 'open',     answerBudget: 200,  thinkingBudget: 0,    sort: 'price',      temperature: 0,   upgrade: false },
  gate:      { tier: 'open',     answerBudget: 100,  thinkingBudget: 0,    sort: 'price',      temperature: 0,   upgrade: false },
  plan:      { tier: 'open',     answerBudget: 400,  thinkingBudget: 0,    sort: 'price',      temperature: 0.7, upgrade: false }, // browser: 400
  todo:      { tier: 'open',     answerBudget: 300,  thinkingBudget: 0,    sort: 'price',      temperature: 0.5, upgrade: false }, // browser: 300
  nextmoves: { tier: 'open',     answerBudget: 400,  thinkingBudget: 0,    sort: 'price',      temperature: 0.7, upgrade: false },
  ideamap:   { tier: 'frontier', answerBudget: 4000, thinkingBudget: 2000, sort: 'throughput', temperature: 0.7, upgrade: false },
  draw:      { tier: 'open',     answerBudget: 4000, thinkingBudget: 2000, sort: 'throughput', temperature: 0.7, upgrade: true },
  edit:      { tier: 'open',     answerBudget: 3000, thinkingBudget: 1000, sort: 'throughput', temperature: 0.2, upgrade: true },
  build:     { tier: 'frontier', answerBudget: 9000, thinkingBudget: 4000, sort: 'throughput', temperature: 0.4, upgrade: false }
};
export const MAX_PRICE = { open: { prompt: 1, completion: 3 }, frontier: { prompt: 5, completion: 25 } };
const MAX_MODELS = 3;

// THIS SECTION IS FOR: the placeholder guard, so /route cannot run live on guessed models.
function usableList(env) {
  if (ALLOWLIST.status === 'placeholder' && !(env && env.AI_ALLOW_PLACEHOLDERS === '1')) {
    throw new Error('model allowlist is a placeholder; run phase 0 step 0.5 first');
  }
  return ALLOWLIST.models;
}

// clues: { difficulty: 'hard'|... }. payload: { hasImage }. person is accepted for the caller's logging and not used to choose.
// avoid: model ids failing too often lately (step 1.20); dropped unless that would leave no model for the job.
export function pick(job, clues, payload, person, env = (typeof process !== 'undefined' ? process.env : {}), avoid = []) {
  const row = ROWS[job];
  if (!row) throw new Error('unknown job: ' + job);
  const models = usableList(env);
  const needImage = !!(payload && payload.hasImage);
  const capable = models.filter((m) => !needImage || m.image);
  const healthy = capable.filter((m) => !avoid.includes(m.id));
  const fit = healthy.length ? healthy : capable;
  const wantFrontier = row.tier === 'frontier' || (row.upgrade && clues && clues.difficulty === 'hard');
  const first = wantFrontier ? 'frontier' : 'open';
  const ordered = fit.filter((m) => m.tier === first).concat(fit.filter((m) => m.tier !== first)).slice(0, MAX_MODELS);
  if (!ordered.length) throw new Error('no allowed model for job ' + job + (needImage ? ' with a picture' : ''));
  return {
    models: ordered.map((m) => m.id),
    effort: wantFrontier ? 'high' : 'low',
    answerBudget: row.answerBudget,
    thinkingBudget: row.thinkingBudget,
    sort: row.sort,
    temperature: row.temperature,
    maxPrice: MAX_PRICE[wantFrontier ? 'frontier' : 'open']
  };
}

// THIS SECTION IS FOR: the hold's worst case (invariant I1). Input estimate + answer + thinking, all at maxPrice, in dollars.
export function worstCaseCost(p, inputTokens) {
  const out = p.answerBudget + p.thinkingBudget;
  return (inputTokens * p.maxPrice.prompt + out * p.maxPrice.completion) / 1e6;
}
