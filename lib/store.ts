import { promises as fs } from "fs";
import path from "path";
import type { ReportMeta } from "./types";
import { toRepoRef } from "./sources";

const DATA_DIR = path.join(process.cwd(), "data");
const REPORTS_DIR = path.join(DATA_DIR, "reports");
const INDEX_FILE = path.join(DATA_DIR, "index.json");

async function ensureDirs(): Promise<void> {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
}

/** Each report is a folder: data/reports/<id>/ with index.html + follow-up docs. */
export function reportDir(id: string): string {
  return path.join(REPORTS_DIR, id);
}

export function reportDocPath(id: string, doc = "index"): string {
  return path.join(REPORTS_DIR, id, `${doc}.html`);
}

export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "report";
}

/** A slug not already in `taken`, suffixing -2, -3, … on collision. */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const slug = slugify(base);
  if (!set.has(slug)) return slug;
  for (let i = 2; ; i++) {
    const candidate = `${slug}-${i}`;
    if (!set.has(candidate)) return candidate;
  }
}

export async function readIndex(): Promise<ReportMeta[]> {
  try {
    const raw = await fs.readFile(INDEX_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReportMeta[]) : [];
  } catch {
    return [];
  }
}

async function writeIndex(list: ReportMeta[]): Promise<void> {
  await ensureDirs();
  await fs.writeFile(INDEX_FILE, JSON.stringify(list, null, 2), "utf8");
}

/** Insert or update a report record, keeping the list newest-first. */
export async function upsertReport(meta: ReportMeta): Promise<void> {
  const list = await readIndex();
  const idx = list.findIndex((r) => r.id === meta.id);
  if (idx === -1) list.unshift(meta);
  else list[idx] = meta;
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  await writeIndex(list);
}

export async function getReport(id: string): Promise<ReportMeta | undefined> {
  const list = await readIndex();
  return list.find((r) => r.id === id);
}

/** Canonical, order-insensitive identity for a set of repo sources. */
function repoKey(repos: string[]): string {
  return repos
    .map((r) => toRepoRef(r).url.toLowerCase())
    .sort()
    .join("|");
}

/** An existing report analyzing the same repo(s), if any (for dedupe-on-Go). */
export async function findExistingReport(
  urls: string[],
): Promise<ReportMeta | undefined> {
  const key = repoKey(urls);
  const list = await readIndex();
  return list.find((r) => repoKey(r.repos) === key);
}

export async function readReportDoc(
  id: string,
  doc = "index",
): Promise<string | undefined> {
  try {
    return await fs.readFile(reportDocPath(id, doc), "utf8");
  } catch {
    return undefined;
  }
}

export async function writeReportDoc(
  id: string,
  doc: string,
  html: string,
): Promise<void> {
  await fs.mkdir(reportDir(id), { recursive: true });
  await fs.writeFile(reportDocPath(id, doc), html, "utf8");
}

/** Follow-up doc slugs already present in a report folder (excludes index). */
export async function listFollowUpSlugs(id: string): Promise<string[]> {
  try {
    const files = await fs.readdir(reportDir(id));
    return files
      .filter((f) => f.endsWith(".html") && f !== "index.html")
      .map((f) => f.replace(/\.html$/, ""));
  } catch {
    return [];
  }
}

/** Delete a whole report: its folder (incl. all follow-ups) and index entry. */
export async function deleteReport(id: string): Promise<void> {
  await fs.rm(reportDir(id), { recursive: true, force: true });
  const list = await readIndex();
  const next = list.filter((r) => r.id !== id);
  if (next.length !== list.length) await writeIndex(next);
}
