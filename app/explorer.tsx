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

  const [followUpText, setFollowUpText] = useState("");
  const [submittingFollowUp, setSubmittingFollowUp] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Which doc of the selected report to show: null = the index/overview.
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  // Set when Go hits an already-analyzed repo (the dedupe prompt).
  const [dupe, setDupe] = useState<{
    existing: ReportMeta;
    steeringText?: string;
  } | null>(null);

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  // When the active job is a follow-up, the report id its output folds into.
  // Mirrors followUpTargetRef for render (refs can't be read during render).
  const [activeFollowUpTarget, setActiveFollowUpTarget] = useState<string | null>(
    null,
  );
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
  // follow-up job id -> the report id its output should fold back into.
  const followUpTargetRef = useRef<Record<string, string>>({});
  const followUpRef = useRef<HTMLTextAreaElement | null>(null);
  const steeringRef = useRef<HTMLTextAreaElement | null>(null);

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
          // A finished follow-up folds back into its target report: re-select it
          // and bump the nonce so the iframe refetches the appended HTML.
          const target = followUpTargetRef.current[id];
          if (target) {
            delete followUpTargetRef.current[id];
            if (ev.ok) {
              setSelectedId(target);
              setSelectedDoc(null); // back to the overview; new doc shows in the sub-nav
              setRefreshNonce((n) => n + 1);
            }
          }
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
    (id: string, followUpTarget: string | null = null) => {
      activeJobRef.current = id;
      setActiveJobId(id);
      setActiveFollowUpTarget(followUpTarget);
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

  // Grow the follow-up textarea to fit its content — no inner scrollbar.
  useEffect(() => {
    const el = followUpRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [followUpText, selectedId]);

  // Grow the steering textarea to fit its content too.
  useEffect(() => {
    const el = steeringRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [steering]);

  const startAnalysis = useCallback(
    async (urls: string[], steeringText?: string, force = false) => {
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
          body: JSON.stringify({ urls, steeringText, force }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 409 && data?.existing) {
            setDupe({ existing: data.existing as ReportMeta, steeringText });
            return;
          }
          setFormError(data?.error ?? "Failed to start analysis.");
          return;
        }
        const meta = data as ReportMeta;
        setReports((prev) => [meta, ...prev.filter((r) => r.id !== meta.id)]);
        reportsRef.current = [
          meta,
          ...reportsRef.current.filter((r) => r.id !== meta.id),
        ];
        setSelectedDoc(null);
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
      setSelectedDoc(null);
      setSelectedId(r.id);
      if (r.status === "running" && r.id !== activeJobRef.current) {
        openJob(r.id);
      }
    },
    [openJob],
  );

  // Show a specific doc of a report (slug = null → the overview/index).
  const jumpToDoc = useCallback((reportId: string, slug: string | null) => {
    setView("reports");
    setSelectedId(reportId);
    setSelectedDoc(slug);
  }, []);

  const deleteReportById = useCallback(async (r: ReportMeta) => {
    if (!window.confirm(`Delete "${r.title}" and all its follow-ups?`)) return;
    try {
      await fetch(`/api/reports/${r.id}`, { method: "DELETE" });
    } catch {
      /* best effort — local app */
    }
    setReports((prev) => prev.filter((x) => x.id !== r.id));
    reportsRef.current = reportsRef.current.filter((x) => x.id !== r.id);
    setSelectedId((cur) => (cur === r.id ? null : cur));
    setSelectedDoc(null);
  }, []);

  // Re-run a report with its saved repos + steering (e.g. after a failure) —
  // nothing is lost because both are persisted on the report the moment Go is hit.
  const rerunReport = useCallback(
    async (r: ReportMeta) => {
      try {
        await fetch(`/api/reports/${r.id}`, { method: "DELETE" });
      } catch {
        /* best effort */
      }
      setReports((prev) => prev.filter((x) => x.id !== r.id));
      reportsRef.current = reportsRef.current.filter((x) => x.id !== r.id);
      await startAnalysis(r.repos, r.steeringText, true);
    },
    [startAnalysis],
  );

  const submitFollowUp = useCallback(
    async (reportId: string) => {
      const request = followUpText.trim();
      if (!request || submittingFollowUp) return;
      setSubmittingFollowUp(true);
      setFormError(null);
      try {
        const res = await fetch("/api/followup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportId, request }),
        });
        const data = await res.json();
        if (!res.ok) {
          setFormError(data?.error ?? "Failed to start follow-up.");
          return;
        }
        const meta = data as ReportMeta;
        // Remember where this follow-up's output belongs, then stream it live
        // using the same machinery as a normal analysis.
        followUpTargetRef.current[meta.id] = reportId;
        setFollowUpText("");
        setSelectedDoc(null);
        setSelectedId(meta.id);
        openJob(meta.id, reportId);
      } catch {
        setFormError("Network error starting follow-up.");
      } finally {
        setSubmittingFollowUp(false);
      }
    },
    [followUpText, submittingFollowUp, openJob],
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

  const selectedReport = reports.find((r) => r.id === selectedId) ?? null;

  // A job we kicked off is in flight (locks "New analysis" + Go).
  const running = activeStatus === "running" || liveLost;

  // Live panel while streaming, or for a follow-up error with no report of its own.
  // (A main-analysis error has a report and falls through to the report view.)
  const showingLiveJob =
    selectedId !== null &&
    selectedId === activeJobId &&
    (running || (activeStatus === "error" && selectedReport === null));

  // Job in flight, for the running header. Follow-ups aren't in `reports`, so fall
  // back to the report they target (activeFollowUpTarget holds that report id).
  const runningMeta =
    reports.find((r) => r.id === activeJobId) ??
    (activeFollowUpTarget
      ? (reports.find((r) => r.id === activeFollowUpTarget) ?? null)
      : null);
  const runningIsFollowUp = !!activeFollowUpTarget;

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
        <div className="px-4 pb-2 pt-3">
          <button
            onClick={() => {
              setView("reports");
              setSelectedDoc(null);
              setSelectedId(null);
            }}
            disabled={running}
            className="w-full rounded-md border border-border px-3 py-2 text-sm text-text hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            + New analysis
          </button>
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
                    <div className="group relative">
                      <button
                        onClick={() => onSelect(r)}
                        className={`block w-full px-4 py-3 pr-9 text-left transition-colors ${
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
                      <button
                        onClick={() => void deleteReportById(r)}
                        title="Delete analysis"
                        aria-label="Delete analysis"
                        className="absolute right-2 top-2.5 rounded p-1 text-sm leading-none text-muted opacity-0 transition-opacity hover:bg-panel-2 hover:text-bad group-hover:opacity-100"
                      >
                        ×
                      </button>
                    </div>
                    {selected && r.followUps && r.followUps.length > 0 && (
                      <div className="border-t border-border px-3 pb-2 pt-1">
                        <div className="flex items-center justify-between py-1">
                          <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
                            Follow-ups
                          </span>
                          <button
                            onClick={() => jumpToDoc(r.id, null)}
                            className={`text-[10px] ${
                              selectedDoc === null
                                ? "text-accent"
                                : "text-muted hover:text-text"
                            }`}
                          >
                            Overview
                          </button>
                        </div>
                        <ul className="space-y-0.5">
                          {r.followUps.map((f) => (
                            <li key={f.slug}>
                              <button
                                onClick={() => jumpToDoc(r.id, f.slug)}
                                title={f.request}
                                className={`block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-panel-2 ${
                                  selectedDoc === f.slug
                                    ? "text-accent"
                                    : "text-muted hover:text-text"
                                }`}
                              >
                                {f.request}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
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
          <div className="flex min-h-0 flex-1 flex-col">
            {showingLiveJob ? (
              /* RUNNING */
              <div className="flex h-full flex-col">
                {runningMeta && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-panel px-4 py-2 text-xs text-muted">
                    <span>{runningIsFollowUp ? "Following up on" : "Analyzing"}</span>
                    {runningMeta.repos.map((u, i) => {
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
                    {!runningIsFollowUp && runningMeta.steeringText && (
                      <span className="basis-full text-muted">
                        Focus: {runningMeta.steeringText}
                      </span>
                    )}
                  </div>
                )}
                <div className="min-h-0 flex-1">
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
                </div>
              </div>
            ) : selectedReport ? (
              /* REPORT (done / error) */
              <div className="flex h-full flex-col">
                {selectedReport.repos.length > 0 && (
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
                    <button
                      onClick={() => void deleteReportById(selectedReport)}
                      className="rounded-md border border-bad/40 px-2 py-0.5 text-[11px] text-bad hover:bg-bad/10"
                    >
                      Delete
                    </button>
                    {selectedReport.status === "error" && (
                      <button
                        onClick={() => void rerunReport(selectedReport)}
                        className="rounded-md border border-border px-2 py-0.5 text-[11px] text-text hover:bg-panel-2"
                      >
                        Retry analysis
                      </button>
                    )}
                    {selectedReport.steeringText && (
                      <span className="flex basis-full items-start gap-2 text-muted">
                        <span>Focus: {selectedReport.steeringText}</span>
                        <button
                          onClick={() =>
                            navigator.clipboard?.writeText(
                              selectedReport.steeringText ?? "",
                            )
                          }
                          title="Copy focus text"
                          className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:bg-panel-2 hover:text-text"
                        >
                          Copy
                        </button>
                      </span>
                    )}
                    {selectedReport.status === "error" &&
                      /usage limit|401|unauthoriz|authenticat|credit|billing/i.test(
                        selectedReport.error ?? "",
                      ) && (
                        <span className="basis-full text-muted">
                          Looks like an auth/usage issue — run{" "}
                          <span className="text-accent">pnpm launch</span> to switch
                          between your Claude subscription and an API key, then restart
                          the dev server.
                        </span>
                      )}
                  </div>
                )}
                <iframe
                  key={`${selectedReport.id}:${selectedDoc ?? "index"}:${refreshNonce}`}
                  src={`/api/reports/${selectedReport.id}${selectedDoc ? `/${selectedDoc}` : ""}`}
                  title="Report"
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                  className="w-full flex-1 border-0 bg-white"
                />
                {selectedReport.status === "done" && (
                  <div className="flex items-end gap-2 border-t border-border bg-panel px-4 py-3">
                    <textarea
                      ref={followUpRef}
                      value={followUpText}
                      onChange={(e) => setFollowUpText(e.target.value)}
                      placeholder="Ask a follow-up — added as a new document to this report — e.g. “dig deeper into their auth”"
                      className="min-h-20 min-w-0 flex-1 resize-none overflow-hidden rounded-md border border-border bg-bg px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                          e.preventDefault();
                          void submitFollowUp(selectedReport.id);
                        }
                      }}
                    />
                    <button
                      onClick={() => void submitFollowUp(selectedReport.id)}
                      disabled={!followUpText.trim() || submittingFollowUp}
                      className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {submittingFollowUp ? "Starting…" : "Ask"}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              /* START — the editable form + banners */
              <div className="flex h-full flex-col">
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
                      disabled={submitting || running}
                      className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {submitting ? "Starting…" : "Go"}
                    </button>
                  </div>
                  <textarea
                    ref={steeringRef}
                    value={steering}
                    onChange={(e) => setSteering(e.target.value)}
                    placeholder="Optional focus for this analysis — e.g. “focus on security”, “just the auth module”, “is it worth porting to Next?”"
                    className="min-h-20 w-full resize-none overflow-hidden rounded-md border border-border bg-bg px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
                  />
                </form>
                {formError && (
                  <div className="border-b border-border bg-bad/10 px-4 py-2 text-sm text-bad">
                    {formError}
                  </div>
                )}
                {dupe && (
                  <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-4 py-2 text-sm text-text">
                    <span>
                      You’ve already analyzed{" "}
                      <span className="font-medium">{dupe.existing.title}</span>.
                    </span>
                    <button
                      onClick={() => {
                        const ex = dupe.existing;
                        const steer = dupe.steeringText;
                        setDupe(null);
                        setSelectedDoc(null);
                        setSelectedId(ex.id);
                        if (steer) setFollowUpText(steer);
                      }}
                      className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-panel-2"
                    >
                      Ask a follow-up
                    </button>
                    <button
                      onClick={() => {
                        const ex = dupe.existing;
                        const steer = dupe.steeringText;
                        setDupe(null);
                        void (async () => {
                          try {
                            await fetch(`/api/reports/${ex.id}`, {
                              method: "DELETE",
                            });
                          } catch {
                            /* best effort */
                          }
                          setReports((prev) => prev.filter((x) => x.id !== ex.id));
                          reportsRef.current = reportsRef.current.filter(
                            (x) => x.id !== ex.id,
                          );
                          await startAnalysis(ex.repos, steer, true);
                        })();
                      }}
                      className="rounded-md border border-bad/40 px-2.5 py-1 text-xs text-bad hover:bg-bad/10"
                    >
                      Delete &amp; start over
                    </button>
                    <button
                      onClick={() => setDupe(null)}
                      className="text-xs text-muted hover:text-text"
                    >
                      Cancel
                    </button>
                  </div>
                )}
                <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted">
                  Paste a repository URL above and hit Go to analyze a repo.
                </div>
              </div>
            )}
          </div>
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
