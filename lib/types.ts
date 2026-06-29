export type ReportMode = "single" | "compare";

export type ReportStatus = "running" | "done" | "error";

export interface ReportMeta {
  id: string;
  title: string;
  mode: ReportMode;
  repos: string[];
  createdAt: string; // ISO timestamp
  status: ReportStatus;
  error?: string;
  costUsd?: number;
  durationMs?: number; // wall-clock time the analysis actually ran
  steeringText?: string; // optional user focus/intent for this run
  sessionId?: string; // Agent SDK session id, so follow-ups can resume the conversation
}

/** A repo from github.com/trending (ephemeral, not persisted). */
export interface TrendingRepo {
  owner: string;
  repo: string;
  url: string; // https://github.com/owner/repo
  description: string;
  language: string | null;
  stars: number | null;
  starsToday: number | null; // stars for the selected period
}

/** Progress events streamed from a running analysis job to the browser. */
export type ProgressEvent =
  | { type: "status"; text: string } // high-level headline ("Cloning repository…")
  | { type: "thinking"; text: string } // the agent's reasoning
  | { type: "text"; text: string } // the agent's narration
  | { type: "tool"; tool: string; detail?: string } // a tool call + its key input
  | { type: "done"; ok: boolean; costUsd?: number; error?: string };
