# Plan: Bookmarks (issue #1 / idea-trending-bookmarks)

Bookmark a repo from the Trending triage flow to revisit later, without analyzing
it yet. Bookmarks appear on a third view that mirrors Trending — same cards, same
Analyze/triage flow — and can be unbookmarked from there.

## Scope

- Add a **Bookmark** action to the triage modal, alongside Not interested / Analyze.
- Persist bookmarks (the full `TrendingRepo`, not just URL — so the view renders
  without re-fetching GitHub).
- Add a **Bookmarks** view (`View = "reports" | "trending" | "bookmarks"`) that
  reuses the Trending card list.
- Unbookmark from the Bookmarks view (and reflect state in the triage modal:
  "Bookmarked ✓" / remove).

## Out of scope (v1)

- Server-side persistence / cross-device sync (see decision below).
- Tags, notes, or ordering on bookmarks.
- A quick-bookmark button directly on the Trending card (modal-only for v1).

## Decision: persistence = localStorage

Mirror the existing `repo-explorer:dismissed` pattern. Key `repo-explorer:bookmarks`,
storing an array of `TrendingRepo` objects (URL-keyed for dedupe).

- **Why:** matches the existing dismissed pattern, zero backend, ships fastest;
  "bookmark to look at later" doesn't need cross-device durability on a local
  single-user app.
- **Trade-off:** browser-bound; stars/desc snapshot at bookmark time go stale.
  Acceptable — the triage modal re-fetches live metadata on open anyway, and
  Analyze always clones fresh.
- **If we ever want durability:** swap to a `data/bookmarks.json` store via the
  `lib/store` pattern + a small `/api/bookmarks` route. The UI seam (a
  `useBookmarks` hook) should make this swap localized.

## Implementation steps

1. **Persistence hook** — `app/explorer.tsx` (or a small `lib/bookmarks.ts` client
   helper). A `useBookmarks()` returning `{ bookmarks: TrendingRepo[], isBookmarked(url),
   addBookmark(repo), removeBookmark(url) }`, backed by localStorage with the same
   lazy-init + effect-write shape as `dismissed`. Centralizing here is the seam that
   makes a future server swap painless.

2. **Triage modal** — add a third footer button:
   - If not bookmarked: **Bookmark** → `addBookmark(repo)`, then close (or keep open
     showing "Bookmarked ✓").
   - If bookmarked: show **Bookmarked ✓** / allow remove.
   - `TriageModal` needs `isBookmarked: boolean` + `onBookmark` / `onUnbookmark` props,
     wired from the parent like `onDismiss`/`onAnalyze`.

3. **Bookmarks view** — extend `View` union; add a nav entry next to Reports/Trending.
   Render the bookmarked `TrendingRepo[]` with the **same card list** TrendingView uses.
   - Refactor the Trending card list into a shared `<RepoCard>` / list component if not
     already, so Bookmarks and Trending render identically. (Check current TrendingView
     structure first — extract minimally, don't over-engineer.)
   - Each card: Analyze (→ triage modal, same flow) + Remove bookmark.
   - Empty state: "No bookmarks yet — bookmark repos from Trending."

4. **Cross-view consistency** — bookmarking from Trending's triage modal should reflect
   immediately if the Bookmarks view is later opened (shared hook/state handles this).
   Decide where `useBookmarks` lives so both views read the same instance — likely lift
   to the top-level `Explorer` component and pass down, rather than per-view local state
   (note: `dismissed` is currently local to `TrendingView` — bookmarks must be higher).

5. **Verify** — production build green; manual smoke: bookmark a repo, switch to
   Bookmarks view, Analyze from there, unbookmark, confirm persistence across reload.

## Open questions

- Should a repo that's been analyzed still show as bookmarkable, or auto-clear from
  bookmarks once a report exists? (Lean: leave it; bookmark + report are independent.)
- Nav placement/label for the third view — "Bookmarks" tab vs icon. (Defer to build.)

## Files likely touched

- `app/explorer.tsx` — `View` union, nav, `useBookmarks`, TriageModal props, Bookmarks
  view, possibly extract a shared card list.
- (optional) `lib/bookmarks.ts` — if the localStorage helper is cleaner as its own module.
- No backend changes for the localStorage path.
</content>
</invoke>
