import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { runAnalysis } from "./analyze";
import { reportHtmlPath, readReportHtml, upsertReport, writeReportHtml } from "./store";
import { SOURCE_MARKER, sourceBannerHtml } from "./sources";
import type { ProgressEvent, ReportMeta } from "./types";

const MAX_CONCURRENT = 3; // run a few analyses at once; the rest queue

interface Job {
  id: string;
  meta: ReportMeta;
  events: ProgressEvent[]; // buffered for late subscribers
  emitter: EventEmitter;
  done: boolean;
}

interface Registry {
  jobs: Map<string, Job>;
  queue: string[];
  active: number;
}

// Persist across Next.js HMR reloads in dev (single Node process).
const g = globalThis as unknown as { __repoExplorerJobs?: Registry };
const registry: Registry =
  g.__repoExplorerJobs ??
  (g.__repoExplorerJobs = { jobs: new Map(), queue: [], active: 0 });

function repoName(url: string): string {
  const cleaned = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const base = cleaned.split("/").pop() || cleaned;
  return base || url;
}

function deriveTitle(urls: string[]): string {
  if (urls.length === 2) return `${repoName(urls[0])} vs ${repoName(urls[1])}`;
  return repoName(urls[0]);
}

export function getJob(id: string): Job | undefined {
  return registry.jobs.get(id);
}

export function subscribe(id: string, listener: (e: ProgressEvent) => void): () => void {
  const job = registry.jobs.get(id);
  if (!job) return () => {};
  job.emitter.on("event", listener);
  return () => job.emitter.off("event", listener);
}

export function startJob(urls: string[], steeringText?: string): ReportMeta {
  const id = randomUUID();
  const meta: ReportMeta = {
    id,
    title: deriveTitle(urls),
    mode: urls.length === 2 ? "compare" : "single",
    repos: urls,
    createdAt: new Date().toISOString(),
    status: "running",
    ...(steeringText ? { steeringText } : {}),
  };

  const job: Job = { id, meta, events: [], emitter: new EventEmitter(), done: false };
  job.emitter.setMaxListeners(0);
  registry.jobs.set(id, job);

  // Persist the running record so it shows in the index immediately.
  void upsertReport(meta);

  registry.queue.push(id);
  pump();

  return meta;
}

/** Start as many queued jobs as the concurrency limit allows. */
function pump(): void {
  while (registry.active < MAX_CONCURRENT && registry.queue.length > 0) {
    const id = registry.queue.shift()!;
    const job = registry.jobs.get(id);
    if (!job) continue;
    registry.active++;
    void runJob(job).finally(() => {
      registry.active--;
      pump();
    });
  }
}

async function runJob(job: Job): Promise<void> {
  const startedAt = Date.now();
  const emit = (e: ProgressEvent) => {
    job.events.push(e);
    job.emitter.emit("event", e);
  };

  const result = await runAnalysis({
    urls: job.meta.repos,
    outFile: reportHtmlPath(job.id),
    appRoot: process.cwd(),
    steeringText: job.meta.steeringText,
    onEvent: emit,
  });

  // Bake a source-repo reference into the saved file so it's self-contained.
  if (result.ok) {
    const html = await readReportHtml(job.id);
    if (html && !html.includes(SOURCE_MARKER)) {
      const out = html.replace(
        /<body([^>]*)>/i,
        `<body$1>${sourceBannerHtml(job.meta.repos)}`,
      );
      await writeReportHtml(job.id, out);
    }
  }

  job.meta = {
    ...job.meta,
    status: result.ok ? "done" : "error",
    error: result.error,
    costUsd: result.costUsd,
    durationMs: Date.now() - startedAt,
  };
  job.done = true;
  await upsertReport(job.meta);

  // Drop the buffer/emitter after a grace period so a just-finished client
  // can still attach and replay the final events.
  setTimeout(() => registry.jobs.delete(job.id), 60_000).unref?.();
}
