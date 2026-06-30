import type { TriageResult } from "./types";

const HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "repo-explorer/1.0",
  ...(process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
};

function computeVerdict(
  stars: number | null,
  lastPush: string | null,
  hasReadme: boolean,
  hasDescription: boolean,
): { verdict: TriageResult["verdict"]; verdictNote: string } {
  const ageDays = lastPush
    ? (Date.now() - new Date(lastPush).getTime()) / 86_400_000
    : null;
  // low-activity check first — a stale 1000-star repo should still show as stale
  if (ageDays !== null && ageDays > 180)
    return { verdict: "low-activity", verdictNote: "Last commit over 6 months ago." };
  if ((stars ?? 0) > 500 && ageDays !== null && ageDays < 30)
    return {
      verdict: "promising",
      verdictNote: "Active project with strong community interest.",
    };
  if (hasReadme || hasDescription)
    return {
      verdict: "informational",
      verdictNote: "Documented project with moderate activity.",
    };
  return { verdict: "unknown", verdictNote: "No documentation or description available." };
}

export async function fetchTriageResult(
  owner: string,
  repo: string,
): Promise<TriageResult> {
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  const [metaResult, contentsResult, readmeResult] = await Promise.allSettled([
    fetch(base, { headers: HEADERS }).then((r) => r.json()),
    fetch(`${base}/contents/`, { headers: HEADERS }).then((r) => r.json()),
    fetch(`${base}/readme`, { headers: HEADERS }).then((r) => r.json()),
  ]);

  const meta = metaResult.status === "fulfilled" ? metaResult.value : null;
  const contents =
    contentsResult.status === "fulfilled" ? contentsResult.value : null;
  const readme = readmeResult.status === "fulfilled" ? readmeResult.value : null;

  if (!meta || meta.message) {
    throw new Error(meta?.message ?? "GitHub API error");
  }

  const stars: number | null = meta.stargazers_count ?? null;
  const language: string | null = meta.language ?? null;
  const description: string | null = meta.description ?? null;
  const lastPush: string | null = meta.pushed_at ?? null;
  const license: string | null = meta.license?.spdx_id ?? null;
  const forks: number | null = meta.forks_count ?? null;
  const topics: string[] = Array.isArray(meta.topics) ? meta.topics : [];

  let rootFiles: string[] = [];
  if (Array.isArray(contents)) {
    const dirs = contents
      .filter((f: { type: string }) => f.type === "dir")
      .map((f: { name: string }) => f.name);
    const files = contents
      .filter((f: { type: string }) => f.type === "file")
      .map((f: { name: string }) => f.name);
    rootFiles = [...dirs, ...files];
  }

  let readmeExcerpt: string | null = null;
  if (readme && readme.content && !readme.message) {
    try {
      readmeExcerpt = Buffer.from(readme.content.replace(/\n/g, ""), "base64")
        .toString("utf8")
        .slice(0, 500);
    } catch {
      readmeExcerpt = null;
    }
  }

  const { verdict, verdictNote } = computeVerdict(
    stars,
    lastPush,
    !!readmeExcerpt,
    !!description,
  );

  return {
    stars,
    language,
    description,
    lastPush,
    license,
    topics,
    forks,
    rootFiles,
    readmeExcerpt,
    verdict,
    verdictNote,
  };
}
