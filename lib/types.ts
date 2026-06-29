export type ReportMode = "single" | "compare";

export type ReportStatus = "running" | "done" | "error";

/** A follow-up document inside a report folder, for the per-report sub-nav. */
export interface FollowUp {
  request: string; // what the user asked
  slug: string; // its doc filename (without .html) under the report folder
  createdAt: string; // ISO timestamp
}

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
  followUps?: FollowUp[]; // follow-up docs in this report's folder, oldest first
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
