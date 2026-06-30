import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ProgressEvent } from "./types";

// The default analysis model. Parameterized through streamQuery so a future
// model-selection feature only needs to thread a value here.
const DEFAULT_MODEL = "claude-sonnet-5";

export interface AnalyzeOptions {
  urls: string[]; // 1 = single review, 2 = comparison
  outFile: string; // absolute path the report must be written to
  appRoot: string; // cwd; the dir whose .claude/skills/ holds the vendored skill
  steeringText?: string; // optional user focus/intent to prime the analysis
  model?: string;
  signal?: AbortSignal;
  onEvent: (e: ProgressEvent) => void;
}

export interface FollowUpOptions {
  outPath: string; // absolute path to write the new follow-up document to
  basePath: string; // absolute path of the report's index.html (for house style)
  repos: string[]; // original sources (for re-cloning if the request needs files)
  request: string; // the user's follow-up request
  resume?: string; // prior session id to resume, when available
  appRoot: string; // cwd; the dir whose .claude/skills/ holds the vendored skill
  signal?: AbortSignal;
  onEvent: (e: ProgressEvent) => void;
}

export interface AnalyzeResult {
  ok: boolean;
  costUsd?: number;
  error?: string;
  sessionId?: string; // captured so follow-ups can resume this conversation
}

function buildPrompt(urls: string[], outFile: string, steeringText?: string): string {
  const compare = urls.length === 2;
  const subject = compare
    ? `${urls[0]} and compare with ${urls[1]}`
    : urls[0];
  const steering = steeringText?.trim();
  return [
    `Use the explore-repo skill to analyze ${subject}.`,
    steering
      ? `The user has asked you to focus on: ${steering} — prioritize this throughout the investigation and weight the report toward it, while still covering the essential structure.`
      : null,
    `Write the single HTML report to this exact absolute path: ${outFile} (its directory already exists).`,
    `This overrides the skill's default ~/repos/ location and naming: use this exact filename, overwrite it if it already exists, and do NOT add any "-2"/numeric suffix. Do not write the report anywhere else.`,
    `Clone each remote repo to a temporary directory and always discard it when finished;`,
    `do not ask whether to keep the clone, and do not leave anything behind.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildFollowUpPrompt(
  outPath: string,
  basePath: string,
  repos: string[],
  request: string,
): string {
  const subject = repos.length === 2 ? `${repos[0]} and ${repos[1]}` : repos[0];
  return [
    `This is a follow-up to an architectural review you produced for ${subject}.`,
    `The original report's overview is at this exact absolute path: ${basePath}. Read it first so you match its house style — the same CSS classes, dark theme, voice, and citation format.`,
    `The user's follow-up request: ${request}`,
    `Write a NEW, self-contained HTML document that answers the request to this exact absolute path: ${outPath} (its directory already exists; use this exact filename, overwrite it if present, and do not add any numeric suffix). Use the same dark-theme house style as the overview, lead with a clear heading that names the follow-up, and include today's date near the top.`,
    `Do not modify ${basePath} or any other file — ${outPath} is the only file you create.`,
    `Use what you already know from this session first. Only if the request requires reading repository files you don't already have, shallow-clone the source(s) to a temporary directory and discard the clone when finished; do not ask whether to keep it. Do not run any keep-clone prompt.`,
  ].join(" ");
}

function truncate(s: string, n = 200): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}

// Matches the ephemeral shallow-clone directory boundary — macOS
// `/var/folders/.../T/tmp.XXXX/<repo>/` or POSIX `/tmp/tmp.XXXX/<repo>/` — so log lines
// show paths relative to the repo root instead of the full disposable clone path.
const CLONE_TMP_RE =
  /\/(?:private\/)?(?:tmp|var\/folders\/[^/\s]+\/[^/\s]+\/T)\/[^/\s]+\/[^/\s]+\//g;

function shorten(s: string): string {
  return s.replace(CLONE_TMP_RE, "");
}

// Bash commands reduced to their path argument(s) only — the verb, flags, and
// pipe syntax are noise in a feed whose job is to show "where", not "how".
const SHELL_FLAG_WITH_VALUE_RE =
  /^-(?:type|name|iname|path|ipath|maxdepth|mindepth|regex)$/;
const SHELL_CONTROL_RE = /^(?:\||&&|\|\||;|>{1,2}|<)$/;

function extractPaths(cmd: string): string | undefined {
  const tokens = (cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) =>
    t.replace(/^["']|["']$/g, ""),
  );
  const paths: string[] = [];
  let skipNext = false;
  let verb: string | undefined; // current pipeline segment's command name
  let sawFirstArg = false;
  for (const tok of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (SHELL_CONTROL_RE.test(tok)) {
      verb = undefined;
      sawFirstArg = false;
      continue;
    }
    if (verb === undefined) {
      verb = tok; // the command name for this pipeline segment, not a path
      continue;
    }
    if (SHELL_FLAG_WITH_VALUE_RE.test(tok)) {
      skipNext = true;
      continue;
    }
    if (tok.startsWith("-") || tok.includes("*") || tok.includes("?") || /^https?:\/\//.test(tok)) {
      continue;
    }
    // grep/egrep/rg take the search pattern as their first non-flag argument.
    if (!sawFirstArg && /^e?grep$|^rg$/.test(verb)) {
      sawFirstArg = true;
      continue;
    }
    sawFirstArg = true;
    paths.push(tok);
  }
  return paths.length ? Array.from(new Set(paths)).join(" ") : undefined;
}

/** Pull the most useful single field out of a tool's input for display. */
function toolDetail(name: string, input: Record<string, unknown>): string | undefined {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  switch (name.toLowerCase()) {
    case "bash": {
      const cmd = s("command");
      if (!cmd) return undefined;
      // git/rm -rf calls already get their own status headline (see toolStatus
      // below) — a raw command line here would just repeat that, not add a path.
      if (/^\s*git\b/.test(cmd) || /rm\s+-rf/.test(cmd)) return undefined;
      const paths = extractPaths(shorten(cmd));
      return paths ? truncate(paths) : undefined;
    }
    case "read":
    case "write":
    case "edit":
      return s("file_path") ? shorten(s("file_path")!) : undefined;
    case "grep":
      return [s("pattern"), s("path") ? shorten(s("path")!) : undefined].filter(Boolean).join("  in  ") || undefined;
    case "glob":
      return s("pattern");
    case "webfetch":
      return s("url");
    case "skill":
      return s("command") ?? s("name");
    case "task":
    case "agent":
      return s("description") ?? s("subagent_type");
    default:
      return undefined;
  }
}

/** Map a tool invocation to a friendly, high-level headline. */
function toolStatus(name: string, input: Record<string, unknown>): string | undefined {
  const lower = name.toLowerCase();
  if (lower === "bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    if (/git\s+clone/.test(cmd)) return "Cloning repository…";
    if (/rev-parse|rev-list|ls-remote/.test(cmd)) return "Resolving commit…";
    if (/rm\s+-rf/.test(cmd)) return "Cleaning up the clone…";
    return undefined;
  }
  if (lower === "skill") return "Loading the explore-repo skill…";
  if (lower === "task" || lower === "agent")
    return "Reading the repository with the Explore subagent — this is the long step…";
  if (["read", "grep", "glob"].includes(lower)) return "Reading source files…";
  if (["write", "edit"].includes(lower)) return "Writing the report…";
  return undefined;
}

interface StreamQueryOptions {
  prompt: string;
  appRoot: string;
  resume?: string; // resume a prior session instead of starting fresh
  model?: string;
  startLabel?: string;
  signal?: AbortSignal;
  onEvent: (e: ProgressEvent) => void;
}

/**
 * Drive a single Agent SDK `query()` run: stream its messages, translate them
 * into ProgressEvents, and return the outcome (including the session id so a
 * follow-up can resume the conversation). Shared by runAnalysis + runFollowUp.
 */
async function streamQuery(opts: StreamQueryOptions): Promise<AnalyzeResult> {
  const { prompt, appRoot, resume, model = DEFAULT_MODEL, onEvent, signal } = opts;
  let lastStatus = "";
  const emitStatus = (text: string) => {
    if (text && text !== lastStatus) {
      lastStatus = text;
      onEvent({ type: "status", text });
    }
  };

  emitStatus(opts.startLabel ?? "Starting analysis…");
  // If token-streaming works for a kind, skip the duplicate complete-message block
  // for that kind. Tracked per-kind so a fallback can't drop the other.
  let sawTextDelta = false;
  let sawThinkingDelta = false;
  let sessionId: string | undefined;

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: appRoot,
        settingSources: ["project"], // discover .claude/skills from the app, not ~/.claude
        skills: ["explore-repo"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true, // stream thinking/text token-by-token
        model,
        ...(resume ? { resume } : {}),
      },
    })) {
      if (signal?.aborted) {
        onEvent({ type: "done", ok: false, error: "Cancelled" });
        return { ok: false, error: "Cancelled", sessionId };
      }
      // Live token deltas — the "document revealing itself" feed.
      if (msg.type === "stream_event") {
        const ev = msg.event as {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string };
        };
        if (ev.type === "content_block_delta" && ev.delta) {
          if (ev.delta.type === "text_delta" && ev.delta.text) {
            sawTextDelta = true;
            onEvent({ type: "text", text: ev.delta.text });
          } else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
            sawThinkingDelta = true;
            onEvent({ type: "thinking", text: ev.delta.thinking });
          }
        }
        continue;
      }

      if (msg.type === "assistant") {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use") {
              const input = (block.input ?? {}) as Record<string, unknown>;
              onEvent({
                type: "tool",
                tool: block.name,
                detail: toolDetail(block.name, input),
              });
              const status = toolStatus(block.name, input);
              if (status) emitStatus(status);
            } else if (
              !sawTextDelta &&
              block.type === "text" &&
              block.text.trim()
            ) {
              // Fallback when token streaming isn't available.
              onEvent({ type: "text", text: block.text.trim() });
            } else if (
              !sawThinkingDelta &&
              block.type === "thinking" &&
              block.thinking?.trim()
            ) {
              onEvent({ type: "thinking", text: block.thinking.trim() });
            }
          }
        }
      } else if (msg.type === "result") {
        sessionId = msg.session_id ?? sessionId;
        // The SDK reports API errors (e.g. usage limits) as subtype "success"
        // with is_error: true and the message in `result` — treat those as errors.
        const r = msg as unknown as {
          subtype?: string;
          is_error?: boolean;
          result?: string;
          total_cost_usd?: number;
        };
        const failed = r.subtype !== "success" || r.is_error === true;
        if (!failed) {
          onEvent({ type: "done", ok: true, costUsd: r.total_cost_usd });
          return { ok: true, costUsd: r.total_cost_usd, sessionId };
        }
        const error = r.result?.trim() || `Agent ended: ${r.subtype}`;
        onEvent({ type: "done", ok: false, error });
        return { ok: false, error, sessionId };
      }
    }
    const error = "Agent stream ended without a result";
    onEvent({ type: "done", ok: false, error });
    return { ok: false, error, sessionId };
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      onEvent({ type: "done", ok: false, error: "Cancelled" });
      return { ok: false, error: "Cancelled", sessionId };
    }
    const error = err instanceof Error ? err.message : String(err);
    onEvent({ type: "done", ok: false, error });
    return { ok: false, error, sessionId };
  }
}

export async function runAnalysis(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  return streamQuery({
    prompt: buildPrompt(opts.urls, opts.outFile, opts.steeringText),
    appRoot: opts.appRoot,
    model: opts.model,
    signal: opts.signal,
    onEvent: opts.onEvent,
  });
}

export async function runFollowUp(opts: FollowUpOptions): Promise<AnalyzeResult> {
  return streamQuery({
    prompt: buildFollowUpPrompt(opts.outPath, opts.basePath, opts.repos, opts.request),
    appRoot: opts.appRoot,
    resume: opts.resume,
    startLabel: "Starting follow-up…",
    signal: opts.signal,
    onEvent: opts.onEvent,
  });
}
