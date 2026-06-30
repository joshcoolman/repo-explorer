"use client";

import { useCallback, useEffect, useState } from "react";
import type { TrendingRepo } from "@/lib/types";

const KEY = "repo-explorer:bookmarks";

export interface BookmarksApi {
  bookmarks: TrendingRepo[];
  isBookmarked: (url: string) => boolean;
  toggleBookmark: (repo: TrendingRepo) => void;
  removeBookmark: (url: string) => void;
}

/**
 * Bookmarked repos, persisted to localStorage. Stores the full TrendingRepo
 * snapshot (not just the URL) so the Bookmarks view renders without re-fetching
 * GitHub. Mirrors the `repo-explorer:dismissed` pattern. Lift this to the
 * top-level component so Trending and Bookmarks views share one instance.
 *
 * Swap point: to make bookmarks durable across browsers, back this with a
 * `data/bookmarks.json` store + `/api/bookmarks` route — the call sites only
 * use the returned API, so the change stays contained here.
 */
export function useBookmarks(): BookmarksApi {
  const [bookmarks, setBookmarks] = useState<TrendingRepo[]>(() => {
    try {
      const raw =
        typeof window !== "undefined" && localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as TrendingRepo[]) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(bookmarks));
    } catch {
      /* storage quota — ignore */
    }
  }, [bookmarks]);

  const isBookmarked = useCallback(
    (url: string) => bookmarks.some((b) => b.url === url),
    [bookmarks],
  );

  const toggleBookmark = useCallback((repo: TrendingRepo) => {
    setBookmarks((prev) =>
      prev.some((b) => b.url === repo.url)
        ? prev.filter((b) => b.url !== repo.url)
        : [repo, ...prev],
    );
  }, []);

  const removeBookmark = useCallback((url: string) => {
    setBookmarks((prev) => prev.filter((b) => b.url !== url));
  }, []);

  return { bookmarks, isBookmarked, toggleBookmark, removeBookmark };
}
