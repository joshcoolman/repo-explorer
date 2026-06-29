"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProgressEvent, ReportMeta, TrendingRepo } from "@/lib/types";
import { fmtCost, fmtDuration } from "@/lib/format";
import { toRepoRef } from "@/lib/sources";

type ActiveStatus = "running" | "done" | "error" | null;
type View = "reports" | "trending";
type Since = "daily" | "weekly" | "monthly";

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Append an event, merging consecutive streamed text/thinking into one line. */
function mergeAppend(list: ProgressEvent[], ev: ProgressEvent): ProgressEvent[] {
  const last = list[list.length - 1];
  if (
    last &&
    (ev.type === "text" || ev.type === "thinking") &&
    last.type === ev.type
  ) {
    const merged = { ...last, text: last.text + ev.text };
    return [...list.slice(0, -1), merged];
  }
  return [...list, ev];
}

export default function Explorer() {
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [urlA, setUrlA] = useState("");
  const [urlB, setUrlB] = useState("");
  const [steering, setSteering] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeStatus, setActiveStatus] = useState<ActiveStatus>(null);
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [jobStartedAt, setJobStartedAt] = useState<number | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [liveLost, setLiveLost] = useState(false);
  const [now, setNow] = useState(0);

  const [view, setView] = useState<View>("reports");
  const [since, setSince] = useState<Since>("daily");
  const [trending, setTrending] = useState<TrendingRepo[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [trendingError, setTrendingError] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const reportsRef = useRef<ReportMeta[]>([]);
  const activeJobRef = useRef<string | null>(null);
  const attachedRef = useRef(false);

  const loadReports = useCallback(async () => {
    try {
      const res = await fetch("/api/reports", { cache: "no-store" });
      if (res.ok) {
        const list: ReportMeta[] = await res.json();
        reportsRef.current = list;
        setReports(list);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const streamJob = useCallback(
    (id: string) => {
      esRef.current?.close();
      const es = new EventSource(`/api/jobs/${id}/events`);
      esRef.current = es;
      es.onmessage = (e) => {
        let ev: ProgressEvent;
        try {
          ev = JSON.parse(e.data);
        } catch {
          return;
        }
        setLastEventAt(Date.now());
        setProgress((p) => mergeAppend(p, ev));
        if (ev.type === "done") {
          es.close();
          setActiveStatus(ev.ok ? "done" : "error");
          void loadReports();
        }
      };
      es.onerror = () => {
        es.close();
        // Could be a finished job (registry dropped) or a server restart.
        void (async () => {
          await loadReports();
          const r = reportsRef.current.find((x) => x.id === id);
          if (!r || r.status === "done") setActiveStatus("done");
          else if (r.status === "error") setActiveStatus("error");
          else setLiveLost(true); // still "running" but no live stream
        })();
      };
    },
    [loadReports],
  );

  const openJob = useCallback(
    (id: string) => {
      activeJobRef.current = id;
      setActiveJobId(id);
      setActiveStatus("running");
      setProgress([]);
      setJobStartedAt(Date.now());
      setLastEventAt(Date.now());
      setNow(Date.now());
      setLiveLost(false);
      streamJob(id);
    },
    [streamJob],
  );

  // Initial load; auto-attach to a running job after a refresh.
  useEffect(() => {
    void (async () => {
      await loadReports();
      if (attachedRef.current) return;
      const running = reportsRef.current.find((r) => r.status === "running");
      if (running) {
        attachedRef.current = true;
        setSelectedId(running.id);
        openJob(running.id);
      }
    })();
    return () => esRef.current?.close();
  }, [loadReports, openJob]);

  // Tick once a second while a job is live, for the elapsed timer.
  useEffect(() => {
    if (activeStatus !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activeStatus]);

  // Refresh the sidebar while any job (incl. background ones) is running.
  useEffect(() => {
    const t = setInterval(() => {
      if (reportsRef.current.some((r) => r.status === "running")) {
        void loadReports();
      }
    }, 5000);
    return () => clearInterval(t);
  }, [loadReports]);

  // Keep the log scrolled to the bottom.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [progress]);

  const startAnalysis = useCallback(
    async (urls: string[], steeringText?: string) => {
      setFormError(null);
      setView("reports");
      if (urls.length === 0) {
        setFormError("Enter at least one repository URL.");
        return;
      }
      setSubmitting(true);
      try {
        const res = await fetch("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls, steeringText }),
        });
        const data = await res.json();
        if (!res.ok) {
          setFormError(data?.error ?? "Failed to start analysis.");
          return;
        }
        const meta = data as ReportMeta;
        setReports((prev) => [meta, ...prev.filter((r) => r.id !== meta.id)]);
        reportsRef.current = [
          meta,
          ...reportsRef.current.filter((r) => r.id !== meta.id),
        ];
        setSelectedId(meta.id);
        openJob(meta.id);
      } catch {
        setFormError("Network error starting analysis.");
      } finally {
        setSubmitting(false);
      }
    },
    [openJob],
  );

  const onSubmit = useCallback(
    (e: { preventDefault: () => void }) => {
      e.preventDefault();
      const urls = [urlA, urlB].map((u) => u.trim()).filter(Boolean);
      const steeringText = steering.trim() || undefined;
      setUrlA("");
      setUrlB("");
      setSteering("");
      void startAnalysis(urls, steeringText);
    },
    [urlA, urlB, steering, startAnalysis],
  );

  const onSelect = useCallback(
    (r: ReportMeta) => {
      setView("reports");
      setSelectedId(r.id);
      if (r.status === "running" && r.id !== activeJobRef.current) {
        openJob(r.id);
      }
    },
    [openJob],
  );

  const loadTrending = useCallback(async (s: Since) => {
    setTrendingLoading(true);
    setTrendingError(null);
    try {
      const res = await fetch(`/api/trending?since=${s}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setTrendingError(data?.error ?? "Could not load trending.");
        setTrending([]);
        return;
      }
      setTrending(data.repos as TrendingRepo[]);
    } catch {
      setTrendingError("Network error loading trending.");
      setTrending([]);
    } finally {
      setTrendingLoading(false);
    }
  }, []);

  const showTrending = useCallback(() => {
    setView("trending");
    if (trending.length === 0 && !trendingLoading) void loadTrending(since);
  }, [trending.length, trendingLoading, since, loadTrending]);

  const onSince = useCallback(
    (s: Since) => {
      setSince(s);
      void loadTrending(s);
    },
    [loadTrending],
  );

  const showingLiveJob =
    selectedId !== null &&
    selectedId === activeJobId &&
    (activeStatus === "running" || activeStatus === "error" || liveLost);

  const selectedReport = reports.find((r) => r.id === selectedId) ?? null;

  // Map canonical repo URL -> its report (prefer a finished one) for trending.
  const reportByUrl = new Map<string, ReportMeta>();
  for (const r of reports) {
    for (const u of r.repos) {
      const key = toRepoRef(u).url;
      const existing = reportByUrl.get(key);
      if (!existing || (existing.status !== "done" && r.status === "done")) {
        reportByUrl.set(key, r);
      }
    }
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      {/* Sidebar */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-panel">
        <div className="border-b border-border px-4 py-4">
          <h1 className="text-sm font-semibold tracking-wide text-text">
            Repo Explorer
          </h1>
          <div className="mt-3 flex gap-1 rounded-md border border-border p-0.5 text-xs">
            {(["reports", "trending"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => (v === "trending" ? showTrending() : setView("reports"))}
                className={`flex-1 rounded px-2 py-1 capitalize transition-colors ${
                  view === v
                    ? "bg-accent text-bg"
                    : "text-muted hover:text-text"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {reports.length === 0 ? (
            <p className="px-4 py-6 text-xs text-muted">
              No reports yet. Generate one to get started.
            </p>
          ) : (
            <ul>
              {reports.map((r) => {
                const selected = r.id === selectedId;
                const meta = [
                  fmtDuration(r.durationMs),
                  fmtCost(r.costUsd),
                ].filter(Boolean);
                return (
                  <li key={r.id}>
                    <button
                      onClick={() => onSelect(r)}
                      className={`block w-full px-4 py-3 text-left transition-colors ${
                        selected ? "bg-panel-2" : "hover:bg-panel-2/60"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <StatusDot status={r.status} />
                        <span className="truncate text-sm text-text">
                          {r.title}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                        <span className="rounded-full border border-border px-1.5 py-px uppercase tracking-wide">
                          {r.mode}
                        </span>
                        <span>{fmtDate(r.createdAt)}</span>
                        {r.status === "running" && (
                          <span className="text-accent">running…</span>
                        )}
                        {meta.length > 0 && <span>· {meta.join(" · ")}</span>}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        {view === "trending" ? (
          <TrendingView
            repos={trending}
            loading={trendingLoading}
            error={trendingError}
            since={since}
            reportByUrl={reportByUrl}
            onSince={onSince}
            onRefresh={() => loadTrending(since)}
            onAnalyze={(url) => startAnalysis([url])}
            onView={(r) => onSelect(r)}
          />
        ) : (
          <>
        {/* Form */}
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-2 border-b border-border bg-panel px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={urlA}
              onChange={(e) => setUrlA(e.target.value)}
              placeholder="github.com/owner/repo  (or owner/repo)"
              className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
            />
            <span className="text-xs text-muted">compare with</span>
            <input
              value={urlB}
              onChange={(e) => setUrlB(e.target.value)}
              placeholder="optional second repo"
              className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
            />
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? "Starting…" : "Go"}
            </button>
          </div>
          <textarea
            value={steering}
            onChange={(e) => setSteering(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Optional focus for this analysis — e.g. “focus on security”, “just the auth module”, “is it worth porting to Next?”"
            className="w-full resize-y rounded-md border border-border bg-bg px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
          />
        </form>
        {formError && (
          <div className="border-b border-border bg-bad/10 px-4 py-2 text-sm text-bad">
            {formError}
          </div>
        )}

        {/* Content */}
        <div className="min-h-0 flex-1">
          {showingLiveJob ? (
            <ProgressPanel
              status={activeStatus}
              liveLost={liveLost}
              events={progress}
              now={now}
              jobStartedAt={jobStartedAt}
              lastEventAt={lastEventAt}
              logRef={logRef}
              onReconnect={() => activeJobId && openJob(activeJobId)}
            />
          ) : selectedId ? (
            <div className="flex h-full flex-col">
              {selectedReport && selectedReport.repos.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-panel px-4 py-2 text-xs text-muted">
                  <span>Source:</span>
                  {selectedReport.repos.map((u, i) => {
                    const ref = toRepoRef(u);
                    return (
                      <a
                        key={i}
                        href={ref.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline"
                      >
                        {ref.label}
                      </a>
                    );
                  })}
                  {selectedReport.steeringText && (
                    <span className="basis-full text-muted">
                      Focus: {selectedReport.steeringText}
                    </span>
                  )}
                </div>
              )}
              <iframe
                key={selectedId}
                src={`/api/reports/${selectedId}`}
                title="Report"
                sandbox="allow-popups allow-popups-to-escape-sandbox"
                className="w-full flex-1 border-0 bg-white"
              />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">
              Paste a repository URL above and hit Go, or pick a past report from
              the sidebar. You can start another while one is running.
            </div>
          )}
        </div>
          </>
        )}
      </main>
    </div>
  );
}

function StatusDot({ status }: { status: ReportMeta["status"] }) {
  const color =
    status === "done"
      ? "bg-good"
      : status === "error"
        ? "bg-bad"
        : "bg-accent animate-pulse";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

function ProgressPanel({
  status,
  liveLost,
  events,
  now,
  jobStartedAt,
  lastEventAt,
  logRef,
  onReconnect,
}: {
  status: ActiveStatus;
  liveLost: boolean;
  events: ProgressEvent[];
  now: number;
  jobStartedAt: number | null;
  lastEventAt: number | null;
  logRef: React.RefObject<HTMLDivElement | null>;
  onReconnect: () => void;
}) {
  const elapsed = jobStartedAt && now ? now - jobStartedAt : 0;
  const sinceLast = lastEventAt && now ? now - lastEventAt : 0;
  const doneEvent = events.find((e) => e.type === "done");
  const statusLines = events.filter((e) => e.type === "status");
  const headline =
    statusLines.length > 0
      ? (statusLines[statusLines.length - 1] as { text: string }).text
      : "Working…";

  return (
    <div className="flex h-full flex-col gap-3 p-6">
      <div className="flex items-center gap-3">
        {status === "running" && !liveLost && (
          <span className="h-3 w-3 animate-pulse rounded-full bg-accent" />
        )}
        {(status === "error" || liveLost) && (
          <span className="h-3 w-3 rounded-full bg-bad" />
        )}
        <span className="text-base text-text">
          {liveLost
            ? "Live progress unavailable — the dev server may have restarted."
            : status === "error"
              ? doneEvent && doneEvent.type === "done"
                ? `Analysis failed: ${doneEvent.error ?? "unknown error"}`
                : "Analysis failed."
              : headline}
        </span>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted">
        {status === "running" && !liveLost && (
          <>
            <span>Elapsed {fmtDuration(elapsed)}</span>
            {sinceLast > 15000 && (
              <span className="text-accent-2">
                still working — last update {Math.round(sinceLast / 1000)}s ago
              </span>
            )}
          </>
        )}
        {liveLost && (
          <button
            onClick={onReconnect}
            className="rounded border border-border px-2 py-1 text-text hover:border-accent"
          >
            Reconnect
          </button>
        )}
      </div>

      <div
        ref={logRef}
        className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-panel p-4 font-mono text-xs leading-relaxed text-muted"
      >
        {events.map((e, i) => (
          <LogLine key={i} event={e} />
        ))}
      </div>
    </div>
  );
}

function LogLine({ event }: { event: ProgressEvent }) {
  if (event.type === "status")
    return <div className="mt-2 text-accent">▸ {event.text}</div>;
  if (event.type === "thinking")
    return (
      <div className="whitespace-pre-wrap italic text-muted/60">
        {event.text}
      </div>
    );
  if (event.type === "text")
    return <div className="whitespace-pre-wrap text-text/90">{event.text}</div>;
  if (event.type === "tool")
    return (
      <div>
        <span className="text-accent-2">{event.tool}</span>
        {event.detail ? <span className="text-muted"> {event.detail}</span> : ""}
      </div>
    );
  if (event.type === "done")
    return (
      <div className={event.ok ? "mt-2 text-good" : "mt-2 text-bad"}>
        {event.ok
          ? `✓ Done${event.costUsd ? ` · ${fmtCost(event.costUsd)}` : ""}`
          : `✗ ${event.error ?? "failed"}`}
      </div>
    );
  return null;
}

function TrendingView({
  repos,
  loading,
  error,
  since,
  reportByUrl,
  onSince,
  onRefresh,
  onAnalyze,
  onView,
}: {
  repos: TrendingRepo[];
  loading: boolean;
  error: string | null;
  since: Since;
  reportByUrl: Map<string, ReportMeta>;
  onSince: (s: Since) => void;
  onRefresh: () => void;
  onAnalyze: (url: string) => void;
  onView: (r: ReportMeta) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-4 py-3">
        <span className="text-sm text-text">Trending on GitHub</span>
        <div className="ml-auto flex gap-1 rounded-md border border-border p-0.5 text-xs">
          {(["daily", "weekly", "monthly"] as Since[]).map((s) => (
            <button
              key={s}
              onClick={() => onSince(s)}
              className={`rounded px-2 py-1 capitalize transition-colors ${
                since === s ? "bg-accent text-bg" : "text-muted hover:text-text"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <button
          onClick={onRefresh}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-text hover:border-accent"
        >
          Refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <p className="px-2 py-6 text-sm text-muted">Loading trending…</p>
        ) : error ? (
          <p className="px-2 py-6 text-sm text-bad">{error}</p>
        ) : repos.length === 0 ? (
          <p className="px-2 py-6 text-sm text-muted">No trending repos found.</p>
        ) : (
          <ul className="mx-auto flex max-w-3xl flex-col gap-3">
            {repos.map((repo) => {
              const report = reportByUrl.get(repo.url);
              return (
                <li
                  key={repo.url}
                  className="rounded-lg border border-border bg-panel p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <a
                        href={repo.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-accent hover:underline"
                      >
                        {repo.owner}/{repo.repo}
                      </a>
                      {repo.description && (
                        <p className="mt-1 text-sm text-muted">
                          {repo.description}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                        {repo.language && <span>{repo.language}</span>}
                        {repo.stars != null && (
                          <span>★ {repo.stars.toLocaleString()}</span>
                        )}
                        {repo.starsToday != null && (
                          <span className="text-accent-2">
                            {repo.starsToday.toLocaleString()} stars {since === "daily" ? "today" : since === "weekly" ? "this week" : "this month"}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0">
                      {report?.status === "done" ? (
                        <button
                          onClick={() => onView(report)}
                          className="rounded-md border border-border px-3 py-1.5 text-xs text-text hover:border-accent"
                        >
                          View report
                        </button>
                      ) : report?.status === "running" ? (
                        <button
                          onClick={() => onView(report)}
                          className="rounded-md border border-border px-3 py-1.5 text-xs text-accent hover:border-accent"
                        >
                          View progress
                        </button>
                      ) : (
                        <button
                          onClick={() => onAnalyze(repo.url)}
                          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90"
                        >
                          Analyze
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
