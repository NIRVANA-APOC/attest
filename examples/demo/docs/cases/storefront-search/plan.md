# storefront-search: search box and dark theme

## Intent

Shoppers on the storefront cannot search: the header is static and the only
way to a product is browsing category pages. The storefront also still ships
light-only styling even though most of its traffic is in the evening. This
case adds a header search box with keyboard-driven results and a dark theme
that follows the operating system, without changing search ranking or the
mobile layout.

## Done when

- Typing in the header search box narrows the visible product grid as you
  type, and Enter opens the first match's product page.
- The dark theme covers the storefront, product and checkout pages, keeps
  contrast at WCAG AA for body text, and shows no flash of light theme on
  load.
- Keyboard only: Tab reaches the search box, the arrow keys move through the
  suggestions, Escape closes them, and focus never gets trapped.
- `cd storefront && npm run build && npm test` passes, and the changed paths
  log no console errors.
- The person has seen the search box and the dark theme in their own browser
  and approved the look.

## Out of scope

Search ranking, analytics events, server-side search (the catalog already
ships to the client), persisting a theme preference to the account, and the
mobile navigation redesign. A theme toggle and search history are out of
scope; the theme follows `prefers-color-scheme`.

## Decisions for you

1. Search runs against the catalog the storefront already loads, or through a
   new search API? **Recommended: client-side over the loaded catalog**,
   because the storefront already ships the full catalog for category pages
   and a new endpoint adds a service and a deploy for no user-visible gain at
   the current catalog size. A server-side search is a separate case.
2. The dark theme follows the operating system, or gets a visible toggle?
   **Recommended: follow `prefers-color-scheme` with no toggle**, because it
   needs no new preference storage or settings UI; a toggle can come later
   without redoing the tokens.
3. Is adding a CSS-variable layer in `storefront/src/theme/` acceptable for a
   case this size? **Recommended: yes**, because both the search results panel
   and the dark theme need the same surface and text tokens; duplicating
   values would make the two branches drift.

## How the work is split

The search box lives in its own module, the header that mounts it and the
catalog page that filters the grid; the theme owns the token layer and the
global stylesheet. Those file sets do not overlap, so both builders run at
once. The header (`Header.tsx`) is a hub for this case: only `search` touches
it, and `theme` styles it through tokens rather than editing it. The reviewer
sits on a different model and checks each branch as it lands. The audit stage
runs after review and before the MR OK gate; the optional `auditor` role is
declared so the person gets a written judgment of the ledger, not just a
machine summary.

```yaml
attest: 1
goal: "Add a keyboard-driven header search and an OS-following dark theme to the storefront"
why: "Shoppers cannot search the catalog, and light-only styling hurts evening traffic (issue #341)"
workflow: attest-case
base: case/storefront-search
profiles:
  claude-build:
    agent: claude
    model: opus
    effort: high
    flags: [--permission-mode, acceptEdits]
    text: workflow:builder
  codex-build:
    agent: codex
    model: gpt-6.1-sol
    effort: high
    flags: [-a, on-request, -s, workspace-write]
    text: workflow:builder
audit:
  mode: shadow
  provider: heuristic
  questions: [plan.risk, plan.clarity, result.fidelity, merge.risk, teardown.safety]
roles:
  search:
    use: codex-build
    goal: "Add the header search box, suggestions and product-grid filtering"
    touches: [storefront/src/search/, storefront/src/components/Header.tsx, storefront/src/pages/CatalogPage.tsx, storefront/src/api/search.ts]
  theme:
    use: claude-build
    goal: "Add the dark token layer and stylesheet so every page follows the OS theme"
    touches: [storefront/src/theme/, storefront/src/app/globals.css]
  review:
    agent: claude
    model: sonnet
    effort: high
    flags: [--permission-mode, acceptEdits]
    goal: "Review each branch as it lands, including the two branches together"
    touches: []
    reviews: [search, theme]
    text: workflow:reviewer
  auditor:
    use: claude-build
    model: sonnet
    goal: "Judge the audit ledger, the results and the merge history before the MR gate"
    touches: []
    group: audit
    depends_on: [review]
    text: workflow:auditor
```

## Role: search

Build the header search box and its result behaviour inside
`storefront/src/search/`, `storefront/src/components/Header.tsx`,
`storefront/src/pages/CatalogPage.tsx` and `storefront/src/api/search.ts`.
Reuse the catalog store the category pages already populate; add no dependency
and no new API. The search box writes the query to the search module; the
catalog page reads it and narrows the product grid. Type-to-filter, keyboard
navigation, Enter to open the first match, Escape to close, and an empty state
that says no products match. Do not edit the theme files, the global
stylesheet or the checkout flow; if the header needs a layout change beyond
mounting the box, report it as blocked rather than editing `layout.tsx`.

Prove it: `cd storefront && npm run build && npm test -- search`, then drive
the header in a dev server on your own port: type two different queries,
arrow through suggestions, press Enter on one product, and press Escape.
Record the queries and what you saw in the result.

## Role: theme

Add the dark token layer under `storefront/src/theme/` and the theme rules in
`storefront/src/app/globals.css`. The theme must follow `prefers-color-scheme`,
apply on first paint with no flash of light theme, and keep body text at WCAG
AA contrast. Use CSS custom properties so the search results panel inherits
the surface and text tokens without a second copy of the values. Do not edit
`Header.tsx`, the search module or the search API; do not touch the mobile
layout or the checkout flow.

Prove it: `cd storefront && npm run build && npm test`, then drive the
storefront, product and checkout pages with the OS set to dark and to light;
record the contrast readings for body text and one screenshot of each page in
your result.

## Role: review

Review each branch as it lands, in plan order (`search`, then `theme`), with
the reviewer rules and the blast-radius table. Beyond them: after both
branches have landed, read them together and check that the search results
panel picks up the dark tokens instead of hard-coding light colours, and that
the header still lays out correctly at 320, 768 and 1280 pixels wide. The
dark-theme branch is the one to run most carefully: check the first-paint
flash and the checkout page, not just the storefront home. Write the evidence
(command or path, reproduction for act-on findings) so the auditor can follow
it.

## Role: auditor

This case has a visual acceptance item and two independently built branches
that meet in the header, so audit both the ledger and the merge history. Read
the plan, `docs/cases/storefront-search/audit.md`, the ledger summary and each
role's result; pay particular attention to a high or unknown `merge.risk`
decision, to whether every file in the merged changes was covered by a review,
and to the done-when item about the person seeing the theme (a visual
criterion must not be ticked from source reading alone). Write
`.attest/audits/storefront-search.md` with `PASS` or `BLOCK: <n> reasons`;
never edit code; do not record `attest audit outcome` unless the orchestrator
asks.
