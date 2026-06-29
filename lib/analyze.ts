import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ProgressEvent } from "./types";

export interface AnalyzeOptions {
  urls: string[]; // 1 = single review, 2 = comparison
  outFile: string; // absolute path the report must be written to
  appRoot: string; // cwd; the dir whose .claude/skills/ holds the vendored skill
  steeringText?: string; // optional user focus/intent to prime the analysis
  onEvent: (e: ProgressEvent) => void;
}

export interface AnalyzeResult {
  ok: boolean;
  costUsd?: number;
  error?: string;
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
    `Write the single HTML report to this exact absolute path: ${outFile}`,
    `— this overrides the skill's default ~/repos/ location and naming. Do not write the report anywhere else.`,
    `Clone each remote repo to a temporary directory and always discard it when finished;`,
    `do not ask whether to keep the clone, and do not leave anything behind.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function truncate(s: string, n = 200): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}

/** Pull the most useful single field out of a tool's input for display. */
function toolDetail(name: string, input: Record<string, unknown>): string | undefined {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  switch (name.toLowerCase()) {
    case "bash":
      return s("command") ? truncate(s("command")!) : undefined;
    case "read":
    case "write":
    case "edit":
      return s("file_path");
    case "grep":
      return [s("pattern"), s("path")].filter(Boolean).join("  in  ") || undefined;
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

export async function runAnalysis(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const prompt = buildPrompt(opts.urls, opts.outFile, opts.steeringText);
  let lastStatus = "";
  const emitStatus = (text: string) => {
    if (text && text !== lastStatus) {
      lastStatus = text;
      opts.onEvent({ type: "status", text });
    }
  };

  emitStatus("Starting analysis…");
  // If token-streaming works for a kind, skip the duplicate complete-message block
  // for that kind. Tracked per-kind so a fallback can't drop the other.
  let sawTextDelta = false;
  let sawThinkingDelta = false;

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: opts.appRoot,
        settingSources: ["project"], // discover .claude/skills from the app, not ~/.claude
        skills: ["explore-repo"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true, // stream thinking/text token-by-token
        model: "claude-opus-4-8",
      },
    })) {
      // Live token deltas — the "document revealing itself" feed.
      if (msg.type === "stream_event") {
        const ev = msg.event as {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string };
        };
        if (ev.type === "content_block_delta" && ev.delta) {
          if (ev.delta.type === "text_delta" && ev.delta.text) {
            sawTextDelta = true;
            opts.onEvent({ type: "text", text: ev.delta.text });
          } else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
            sawThinkingDelta = true;
            opts.onEvent({ type: "thinking", text: ev.delta.thinking });
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
              opts.onEvent({
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
              opts.onEvent({ type: "text", text: block.text.trim() });
            } else if (
              !sawThinkingDelta &&
              block.type === "thinking" &&
              block.thinking?.trim()
            ) {
              opts.onEvent({ type: "thinking", text: block.thinking.trim() });
            }
          }
        }
      } else if (msg.type === "result") {
        if (msg.subtype === "success") {
          opts.onEvent({ type: "done", ok: true, costUsd: msg.total_cost_usd });
          return { ok: true, costUsd: msg.total_cost_usd };
        }
        const error = `Agent ended: ${msg.subtype}`;
        opts.onEvent({ type: "done", ok: false, error });
        return { ok: false, error };
      }
    }
    const error = "Agent stream ended without a result";
    opts.onEvent({ type: "done", ok: false, error });
    return { ok: false, error };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    opts.onEvent({ type: "done", ok: false, error });
    return { ok: false, error };
  }
}
