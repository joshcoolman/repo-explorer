# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

> The import above carries the Next.js 16 rules — read it first; this project's framework APIs differ from training-data Next.js.

## What this is

A **local-only** web GUI around the `explore-repo` skill and its **personas** — swappable variants with a different investigation scope and report template. The user pastes one or two GitHub repos, picks a persona (default: `explore-repo`'s general architecture review); the app runs the chosen skill **headlessly via the Claude Agent SDK**, which shallow-clones each repo to a temp dir, reads it with an Explore subagent, writes a self-contained HTML report to `data/reports/`, and discards the clone. Past reports are indexed in a sidebar.

It shells out to `git` and runs a token-heavy agent on the user's machine — never expose it publicly. Billing is on the user's `ANTHROPIC_API_KEY` (`.env.local`).

## Commands

```bash
pnpm dev         # http://localhost:3000 (Turbopack by default — no --turbopack flag)
pnpm build       # production build
pnpm start       # serve the production build
pnpm lint        # eslint (next lint was removed in Next 16; this calls eslint directly)
```

No test framework is configured. Per global instructions: don't run `pnpm dev` (the user runs the server); verify changes with a production build instead. Requires Node 20.9+ and `git` on PATH. This repo uses pnpm (committed `pnpm-lock.yaml`).

## Architecture

The request flow (see README's diagram for the HTTP surface):

```
Browser → POST /api/jobs            → startJob(): enqueue an in-process job
        → GET  /api/jobs/[id]/events → SSE replay of buffered ProgressEvents, then live
        → GET  /api/reports          → list from data/index.json
        → GET  /api/reports/[id]     → serve data/reports/<id>.html
        → GET  /api/trending         → scrape github.com/trending (cheerio)
```

Everything runs **in one Node process**; there is no external queue or DB. Key pieces:

- **[lib/jobs.ts](lib/jobs.ts)** — the orchestrator. A `Registry` (jobs map + queue + active count) stashed on `globalThis` so it **survives Next HMR reloads** in dev. `MAX_CONCURRENT = 3`; `pump()` drains the queue. Each job buffers its `ProgressEvent[]` and re-emits via an `EventEmitter`, so a late SSE subscriber replays history then streams live. Finished jobs are deleted from memory after a 60s grace window (completed HTML persists on disk). After a successful run it injects a "Source:" banner into the saved HTML so the file is self-contained.

- **[lib/analyze.ts](lib/analyze.ts)** — the only Agent SDK touchpoint. Wraps `query()` with `skills: [persona]` (defaults to `"explore-repo"` via `DEFAULT_PERSONA`), `settingSources: ["project"]` (so the skill resolves from the app's vendored `.claude/skills/`, not `~/.claude`), `permissionMode: "bypassPermissions"`, `includePartialMessages: true`. Translates the raw SDK message stream into the app's `ProgressEvent` union: token deltas → `text`/`thinking`, tool calls → friendly `status`/`tool` headlines, result → `done`. The model id lives here too.

- **[lib/personas.ts](lib/personas.ts)** — reads the persona registry (`.claude/skills/personas.json`) fresh on every call, no caching. `PersonaEntry` — `{ id, skillFolder, label, description }` — is defined in `lib/types.ts` so `app/explorer.tsx` can import the type without pulling in this fs-touching module. New personas are scaffolded via the `create-persona` meta-skill (`.claude/skills/create-persona/`), not through the app.

- **[lib/store.ts](lib/store.ts)** — flat-file persistence under `data/` (gitignored): `index.json` manifest (newest-first) + one `<uuid>.html` per report. No DB.

- **[lib/types.ts](lib/types.ts)** — `ReportMeta`, `ProgressEvent` (the SSE contract), `TrendingRepo`, `PersonaEntry`. Start here to understand the data model.

- **[lib/sources.ts](lib/sources.ts)** — URL normalization (`owner/repo`, full URL, or `git@` SSH → canonical web URL) and the injected source-banner HTML.

- **[app/explorer.tsx](app/explorer.tsx)** — the client UI; consumes the SSE stream.

## Session orientation

At the start of a session, read `## Status` at the bottom of `README.md` and check [open GitHub issues](https://github.com/joshcoolman/repo-explorer/issues) to understand what was last shipped and what's outstanding.

## Important conventions

- **The job registry is process-local and ephemeral.** A server restart loses in-flight jobs (acceptable for a local app) but not completed reports. Don't assume jobs survive restarts.
- **The `explore-repo` skill under `.claude/skills/` is a vendored copy** of the canonical skill at `~/.claude/skills/explore-repo/`. Re-copy to pick up upstream changes; don't expect it to auto-update.
- **Personas are project-local, not vendored.** `.claude/skills/personas.json` is the registry the app reads (via `lib/personas.ts` / `GET /api/personas`); each entry's `skillFolder` names a sibling skill directory under `.claude/skills/`. Unlike `explore-repo`, new personas are authored directly in this repo via the `create-persona` meta-skill — they have no canonical global copy unless the user manually copies one to `~/.claude/skills/` afterward.
- **`@anthropic-ai/claude-agent-sdk` is in `serverExternalPackages`** ([next.config.ts](next.config.ts)) so its bundled binary resolves from `node_modules` at runtime — don't remove that or bundle it.
- The prompt in `buildPrompt()` forces the report to an exact absolute path, overriding the skill's default `~/repos/` location. Keep that override if you touch the prompt.
</content>
