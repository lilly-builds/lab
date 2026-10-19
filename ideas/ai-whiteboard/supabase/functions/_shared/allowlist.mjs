// THIS FILE IS FOR: the models the toolbox may call (build plan 1.4). Phase 0 step 0.5 replaces the placeholders with real ids and sets
// status to 'live'. A module, not a JSON file: a deployed Edge Function carries only what it imports, so a file read off disk could be
// missing there.
export const ALLOWLIST = {
  status: 'placeholder',
  note: 'Guesses until phase 0 step 0.5 runs live. pick() refuses this list unless AI_ALLOW_PLACEHOLDERS=1.',
  models: [
    { id: 'placeholder/open-small', tier: 'open', image: false },
    { id: 'placeholder/open-vision', tier: 'open', image: true },
    { id: 'placeholder/frontier-vision', tier: 'frontier', image: true },
    { id: 'placeholder/frontier-text', tier: 'frontier', image: false }
  ]
};
