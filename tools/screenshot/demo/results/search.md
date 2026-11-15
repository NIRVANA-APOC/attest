---
status: done
summary: Header search filters the catalog as you type; 12 tests pass
---

- `SearchBox` filters the catalog the storefront already loads; no new API.
- Tab reaches the box, arrow keys move the suggestions, Escape clears them,
  Enter opens the first match.
- Empty state: "No products match “<query>”."
- Proved: `cd storefront && npm run build && npm test -- search` (12 passed);
  drove the dev server with `linen`, `sale`, `zz` and each keyboard path.
