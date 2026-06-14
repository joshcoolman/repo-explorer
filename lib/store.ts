import { promises as fs } from "fs";
import path from "path";
import type { ReportMeta } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const REPORTS_DIR = path.join(DATA_DIR, "reports");
const INDEX_FILE = path.join(DATA_DIR, "index.json");

async function ensureDirs(): Promise<void> {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
}

export function reportHtmlPath(id: string): string {
  return path.join(REPORTS_DIR, `${id}.html`);
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

export async function readReportHtml(id: string): Promise<string | undefined> {
  try {
    return await fs.readFile(reportHtmlPath(id), "utf8");
  } catch {
    return undefined;
  }
}

export async function writeReportHtml(id: string, html: string): Promise<void> {
  await ensureDirs();
  await fs.writeFile(reportHtmlPath(id), html, "utf8");
}
