---
status: done
summary: Both branches pass; search results inherit the dark tokens, header holds at 320/768/1280
done_when: ['1', '2', '3', '4']
---

- `search`: PASS. Keyboard paths checked by hand and by test; header diff is
  the mount only. One nit (result list loses the accent underline) is
  non-blocking and left for the next case.
- `theme`: PASS. First paint is dark with no flash; the search results panel
  inherits `--surface-raised` and `--accent` rather than hard-coding light
  values. Product and cart pages checked at 320, 768 and 1280 px.
- Together: the header lays out at all three widths; no overlapping tokens.
- Criterion 5 (the person sees the look in their own browser) is not mine to
  tick; it stays open for the person at the MR gate.
