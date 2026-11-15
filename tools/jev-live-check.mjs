#!/usr/bin/env node
// Live smoke check for the optional hosted Jev provider (the default is the
// offline heuristic). Reads ATTEST_JEV_API_KEY from the environment, sends one
// plan state with two typed questions, and prints only the safe envelope: model,
// latency, token usage and answers. The key is never printed or written.
//
//   npm run build
//   ATTEST_JEV_API_KEY=... node tools/jev-live-check.mjs
//
// Optional: ATTEST_JEV_BASE_URL, ATTEST_JEV_MODEL, ATTEST_JEV_TIMEOUT_MS.
import { typeSafeProvider } from '../dist/jev/typesafe.js'
import { QUESTIONS } from '../dist/jev/decisions.js'

if ((process.env.ATTEST_JEV_API_KEY ?? '').trim() === '') {
  console.error('jev-live-check: set ATTEST_JEV_API_KEY (it is read from the environment only)')
  process.exit(2)
}

const state = {
  goal: 'Add a header search box and a system-following dark theme',
  why: 'The storefront has no search and ships light-only styling',
  doneWhen: ['search filters as you type', 'dark theme follows prefers-color-scheme'],
  roles: ['search', 'theme', 'review', 'auditor'],
  plan: 'Two builders own disjoint touches; a reviewer checks each branch; an auditor reads the audit report before the MR gate.',
  hazards: [],
}

const provider = typeSafeProvider()
for (const id of ['plan.risk', 'plan.clarity']) {
  const result = await provider.decide({ id, state, questions: QUESTIONS[id], stateDigest: 'sha256:jev-live-check' })
  console.log(JSON.stringify({ id, provider: result.provider, model: result.model, latencyMs: result.latencyMs, usage: result.usage, answers: result.answers }, null, 2))
}
