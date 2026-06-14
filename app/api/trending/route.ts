import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import type { TrendingRepo } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Since = "daily" | "weekly" | "monthly";
const TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  repos: TrendingRepo[];
}

const g = globalThis as unknown as {
  __repoExplorerTrending?: Map<Since, CacheEntry>;
};
const cache: Map<Since, CacheEntry> =
  g.__repoExplorerTrending ?? (g.__repoExplorerTrending = new Map());

function parseSince(v: string | null): Since {
  return v === "weekly" || v === "monthly" ? v : "daily";
}

function toInt(s: string | undefined): number | null {
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : null;
}

function parseTrending(html: string): TrendingRepo[] {
  const $ = cheerio.load(html);
  const repos: TrendingRepo[] = [];

  $("article.Box-row").each((_, el) => {
    const $row = $(el);
    const href = ($row.find("h2 a").attr("href") ?? "").trim();
    const segs = href.split("/").filter(Boolean);
    if (segs.length < 2) return;
    const [owner, repo] = segs;

    const description = $row.find("p").first().text().trim();
    const language =
      $row.find("[itemprop=programmingLanguage]").first().text().trim() || null;
    const stars = toInt($row.find('a[href$="/stargazers"]').first().text());
    const periodMatch = $row
      .text()
      .match(/([\d,]+)\s+stars\s+(?:today|this week|this month)/i);
    const starsToday = periodMatch ? toInt(periodMatch[1]) : null;

    repos.push({
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}`,
      description,
      language,
      stars,
      starsToday,
    });
  });

  return repos;
}

export async function GET(req: NextRequest) {
  const since = parseSince(req.nextUrl.searchParams.get("since"));

  const cached = cache.get(since);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return NextResponse.json({
      since,
      fetchedAt: cached.fetchedAt,
      repos: cached.repos,
    });
  }

  try {
    const res = await fetch(`https://github.com/trending?since=${since}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `GitHub returned ${res.status}` },
        { status: 502 },
      );
    }
    const repos = parseTrending(await res.text());
    const fetchedAt = Date.now();
    cache.set(since, { fetchedAt, repos });
    return NextResponse.json({ since, fetchedAt, repos });
  } catch (err) {
    const message = err instanceof Error ? err.message : "fetch failed";
    return NextResponse.json(
      { error: `Could not load trending: ${message}` },
      { status: 502 },
    );
  }
}
