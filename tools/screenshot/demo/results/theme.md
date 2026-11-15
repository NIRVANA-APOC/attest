---
status: done
summary: Dark token layer follows prefers-color-scheme, applied on first paint; 9 tests pass
---

- `storefront/src/theme/tokens.css` defines every surface, text and border
  token for light and dark; `globals.css` imports it first, so first paint is
  already dark.
- Search results and the header pick the tokens up without a second copy.
- Contrast: body text 14.7:1 light, 12.1:1 dark; muted text 5.2:1 both.
- Proved: `cd storefront && npm run build && npm test` (9 passed); drove the
  storefront, product and cart pages with the OS in dark and light.
