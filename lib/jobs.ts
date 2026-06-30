import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { runAnalysis, runFollowUp } from "./analyze";
import {
  adoptDocIfMissing,
  ensureReportDir,
  getReport,
  listFollowUpSlugs,
  readIndex,
  readReportDoc,
  reportDocPath,
  uniqueSlug,
  upsertReport,
  writeReportDoc,
} from "./store";
import { SOURCE_MARKER, sourceBannerHtml } from "./sources";
import type { ProgressEvent, ReportMeta } from "./types";

const MAX_CONCURRENT = 3; // run a few analyses at once; the rest queue

interface Job {
  id: string;
  meta: ReportMeta;
  events: ProgressEvent[]; // buffered for late subscribers
  emitter: EventEmitter;
  done: boolean;
  abortController?: AbortController;
  // Present only for follow-up jobs: write a new doc into an existing report
  // folder instead of producing a brand-new report.
  followUp?: {
    targetReportId: string;
    request: string;
    docSlug: string;
    original: ReportMeta;
  };
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

export function cancelJob(id: string): boolean {
  const job = registry.jobs.get(id);
  if (!job || job.done) return false;
  job.abortController?.abort();
  return true;
}

export function subscribe(id: string, listener: (e: ProgressEvent) => void): () => void {
  const job = registry.jobs.get(id);
  if (!job) return () => {};
  job.emitter.on("event", listener);
  return () => job.emitter.off("event", listener);
}

export async function startJob(
  urls: string[],
  steeringText?: string,
  model?: string,
): Promise<ReportMeta> {
  const takenIds = (await readIndex()).map((r) => r.id);
  const id = uniqueSlug(deriveTitle(urls), takenIds);
  const meta: ReportMeta = {
    id,
    title: deriveTitle(urls),
    mode: urls.length === 2 ? "compare" : "single",
    repos: urls,
    createdAt: new Date().toISOString(),
    status: "running",
    ...(steeringText ? { steeringText } : {}),
    ...(model ? { model } : {}),
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
  if (job.followUp) return runFollowUpJob(job);

  const startedAt = Date.now();
  const abortController = new AbortController();
  job.abortController = abortController;

  const emit = (e: ProgressEvent) => {
    job.events.push(e);
    job.emitter.emit("event", e);
  };

  await ensureReportDir(job.id); // so the agent writes into an existing folder

  const result = await runAnalysis({
    urls: job.meta.repos,
    outFile: reportDocPath(job.id, "index"),
    appRoot: process.cwd(),
    steeringText: job.meta.steeringText,
    model: job.meta.model,
    signal: abortController.signal,
    onEvent: emit,
  });

  // The agent reports success; confirm a report file actually landed (adopting a
  // stray filename if needed). A "done" with no file would be a ghost report.
  let ok = result.ok;
  if (ok) {
    await adoptDocIfMissing(job.id, "index");
    const html = await readReportDoc(job.id, "index");
    if (!html) {
      ok = false;
    } else if (!html.includes(SOURCE_MARKER)) {
      // Bake a source-repo reference in so the saved file is self-contained.
      const out = html.replace(
        /<body([^>]*)>/i,
        `<body$1>${sourceBannerHtml(job.meta.repos)}`,
      );
      await writeReportDoc(job.id, "index", out);
    }
  }

  job.meta = {
    ...job.meta,
    status: ok ? "done" : "error",
    error: ok
      ? undefined
      : result.error ?? "The analysis finished but no report file was written.",
    costUsd: result.costUsd,
    durationMs: Date.now() - startedAt,
    sessionId: result.sessionId ?? job.meta.sessionId,
  };
  job.done = true;
  await upsertReport(job.meta);

  // Drop the buffer/emitter after a grace period so a just-finished client
  // can still attach and replay the final events.
  setTimeout(() => registry.jobs.delete(job.id), 60_000).unref?.();
}

/**
 * Start a follow-up: resume the report's session and write a NEW document into
 * the report's folder. Returns the follow-up *job* meta (its id only streams
 * progress); the new doc is recorded on the original report. Returns undefined
 * if the report is missing or not done.
 */
export async function startFollowUp(
  reportId: string,
  request: string,
): Promise<ReportMeta | undefined> {
  const original = await getReport(reportId);
  if (!original || original.status !== "done") return undefined;

  const docSlug = uniqueSlug(request, await listFollowUpSlugs(reportId));
  const id = randomUUID(); // job id, distinct from the report's slug id
  const meta: ReportMeta = {
    id,
    title: `${original.title} (follow-up)`,
    mode: original.mode,
    repos: original.repos,
    createdAt: new Date().toISOString(),
    status: "running",
  };

  const job: Job = {
    id,
    meta,
    events: [],
    emitter: new EventEmitter(),
    done: false,
    followUp: { targetReportId: reportId, request, docSlug, original },
  };
  job.emitter.setMaxListeners(0);
  registry.jobs.set(id, job);
  // Not persisted via upsertReport — follow-ups record onto the original report.

  registry.queue.push(id);
  pump();

  return meta;
}

async function runFollowUpJob(job: Job): Promise<void> {
  const startedAt = Date.now();
  const abortController = new AbortController();
  job.abortController = abortController;

  const emit = (e: ProgressEvent) => {
    job.events.push(e);
    job.emitter.emit("event", e);
  };
  const { targetReportId, request, docSlug, original } = job.followUp!;
  await ensureReportDir(targetReportId);

  const result = await runFollowUp({
    outPath: reportDocPath(targetReportId, docSlug),
    basePath: reportDocPath(targetReportId, "index"),
    repos: original.repos,
    request,
    resume: original.sessionId,
    appRoot: process.cwd(),
    signal: abortController.signal,
    onEvent: emit,
  });

  // Confirm the follow-up doc actually landed before recording it.
  let ok = result.ok;
  if (ok) {
    const html = await readReportDoc(targetReportId, docSlug);
    if (!html) {
      ok = false;
    } else if (!html.includes(SOURCE_MARKER)) {
      const out = html.replace(
        /<body([^>]*)>/i,
        `<body$1>${sourceBannerHtml(original.repos)}`,
      );
      await writeReportDoc(targetReportId, docSlug, out);
    }
  }

  // Record the follow-up on the ORIGINAL report only if its doc was written.
  const latest = (await getReport(targetReportId)) ?? original;
  await upsertReport({
    ...latest,
    costUsd: (latest.costUsd ?? 0) + (result.costUsd ?? 0),
    sessionId: result.sessionId ?? latest.sessionId,
    ...(ok
      ? {
          followUps: [
            ...(latest.followUps ?? []),
            { request, slug: docSlug, createdAt: new Date().toISOString() },
          ],
        }
      : {}),
  });

  job.meta = {
    ...job.meta,
    status: ok ? "done" : "error",
    error: ok
      ? undefined
      : result.error ?? "The follow-up finished but no document was written.",
    costUsd: result.costUsd,
    durationMs: Date.now() - startedAt,
  };
  job.done = true;

  setTimeout(() => registry.jobs.delete(job.id), 60_000).unref?.();
}
