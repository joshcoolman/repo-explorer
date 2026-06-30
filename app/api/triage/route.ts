import { NextRequest, NextResponse } from "next/server";
import { toRepoRef } from "@/lib/sources";
import type { TriageResult } from "@/lib/types";
import { fetchTriageResult } from "@/lib/triage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const g = globalThis as {
  __repoExplorerTriage?: Map<string, { at: number; result: TriageResult }>;
};
const TTL = 5 * 60 * 1000;

function getCache() {
  return (g.__repoExplorerTriage ??= new Map());
}

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { url } = body;
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "Missing or invalid `url`." }, { status: 400 });
  }

  const normalized = toRepoRef(url);
  const parts = new URL(normalized.url).pathname.split("/").filter(Boolean);
  const [owner, repo] = parts;
  if (!owner || !repo) {
    return NextResponse.json(
      { error: "Could not extract owner/repo from URL." },
      { status: 400 },
    );
  }

  const cache = getCache();
  const key = `${owner}/${repo}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL) {
    return NextResponse.json(cached.result);
  }

  try {
    const result = await fetchTriageResult(owner, repo);
    cache.set(key, { at: Date.now(), result });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "GitHub API error";
    if (/rate limit/i.test(msg)) {
      return NextResponse.json(
        {
          error:
            "GitHub API rate limit exceeded. Set GITHUB_TOKEN in .env.local to raise the limit to 5000 req/hr.",
        },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
