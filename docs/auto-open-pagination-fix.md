# Auto-open pagination race

## Reproduction

With 50 files per page, visit folder A to cache its first page, switch to B,
enable auto-open #74 and return to A while delaying A's second-page response.
The original code deterministically selected A's 24th file even though the
list subsequently displayed page 2.

The pending selection held only a page-relative offset (23). Its effect consumed
whichever items were available first, including cached page 1 or placeholder
data retained by React Query, and cleared the pending selection before page 2
arrived. Cache and response timing made the user-visible failure intermittent.

## Fix

Keep the target folder, requested page and folder-wide index together. Consume
the selection only when the query is no longer showing placeholder data and
its folder, page and page size match the target. Clamp out-of-range indices to
the folder's final file, as required by SPEC.md. Clear pending selections when
auto-open is disabled; preserve explicit sibling-folder navigation selections.

## Validation

- The new #74 regression test fails before the fix, showing `a_024.npz` in the
  file information header instead of `a_074.npz`.
- All 10 targeted Playwright tests pass after the fix: #50/#51/#74/#100/#101,
  shorter folders, page size 25, cancelled pending selection, late previous-folder
  responses and sibling-folder navigation.
- Frontend typecheck and production build pass.
- Full Playwright suite: 38 passed, including compare visibility, gallery scroll,
  overlay/operator behavior, sequence playback and scrubber frame handling.
