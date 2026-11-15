#!/usr/bin/env node
// A scripted stand-in for a coding agent, for the screenshot harness only.
//
// The panel, the CLI, the run log, the audit ledger, the git worktrees, the
// commits and the result files in the captured frames are all real; only the
// agent binaries are scripted, so a maintainer without Claude Code or Codex
// signed in can still reproduce the frames. The script prints the tail of a
// plausible session and stays alive so attest sees a live pane.
import { basename } from 'node:path'

const role = basename(process.cwd())

const frames = {
  search: [
    '⬢ codex  search',
    '  ⏺ Read the brief in .attest/brief.md',
    '  ⏺ Added the header search box and client-side catalog matching',
    '  ⏺ Arrow keys, Enter and Escape wired; empty state added',
    '  ✓ npm run build && npm test -- search · 12 passed',
    '  ❯',
  ],
  theme: [
    '✻ claude  theme',
    '  ⏺ Read the brief in .attest/brief.md',
    '  ⏺ Added the dark token layer in storefront/src/theme/tokens.css',
    '  ⏺ globals.css imports the tokens first, so first paint is already dark',
    '  ✓ npm test · 9 passed',
    '  ❯',
  ],
  review: [
    '✻ claude  review',
    '  ⏺ Read role/storefront-search/search and role/storefront-search/theme',
    '  ⏺ Checked the done-when criteria against both diffs',
    '  ⏺ Running npm test in the search worktree',
    '',
    'Do you want to proceed?',
    '  ❯ 1. Yes',
    '    2. No, and tell Claude what to do differently',
  ],
  auditor: [
    '✻ claude  auditor',
    '  ⏺ Reading docs/cases/storefront-search/audit.md',
    '  ⏺ Checking every merged change against a review',
    '  ❯',
  ],
}

process.stdout.write(`${(frames[role] ?? [`agent  ${role}`, '  ❯']).join('\n')}\n`)
// Keep the pane alive; attest only reads the screen.
setInterval(() => {}, 1 << 30)
