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
  model?: string; // claude model id used for this run
  persona?: string; // persona registry entry id used for this run (e.g. "explore-repo")
  sessionId?: string; // Agent SDK session id, so follow-ups can resume the conversation
  followUps?: FollowUp[]; // follow-up docs in this report's folder, oldest first
}

/** An entry in the persona registry (.claude/skills/personas.json). */
export interface PersonaEntry {
  id: string; // referenced from ReportMeta.persona and the API payload
  skillFolder: string; // directory name under .claude/skills/, fed to the SDK's `skills: [...]`
  label: string; // human-friendly name for the selector/badge
  description: string; // one-liner shown as a tooltip
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

export interface TriageResult {
  stars: number | null;
  language: string | null;
  description: string | null;
  lastPush: string | null;
  license: string | null;
  topics: string[];
  forks: number | null;
  rootFiles: string[];
  readmeExcerpt: string | null;
  verdict: "promising" | "informational" | "low-activity" | "unknown";
  verdictNote: string;
}

/** Progress events streamed from a running analysis job to the browser. */
export type ProgressEvent =
  | { type: "status"; text: string } // high-level headline ("Cloning repository…")
  | { type: "thinking"; text: string } // the agent's reasoning
  | { type: "text"; text: string } // the agent's narration
  | { type: "tool"; tool: string; detail?: string } // a tool call + its key input
  | { type: "done"; ok: boolean; costUsd?: number; error?: string };
