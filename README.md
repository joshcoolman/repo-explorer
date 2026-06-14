# Repo Explorer

A local web GUI around the `explore-repo` skill. Paste one or two GitHub URLs, hit
**Go**, and it generates a self-contained HTML architectural review — then keeps an
index of past reports you can browse in the sidebar.

It runs the skill **headlessly** via the local [Claude Agent SDK]
(`@anthropic-ai/claude-agent-sdk`): the agent shallow-clones each repo to a temp
dir, an Explore subagent reads it, and a single HTML report is written to
`data/reports/`. The clone is always discarded.

This is a **local-only** app. It shells out to `git` and runs an agent on your
machine, so don't expose it publicly.

> [!WARNING]
> Analysis is resource- and token-heavy. Each review runs on your own Anthropic
> API key — see the per-run costs in the sidebar of the screenshot below.

![Repo Explorer showing a finished architectural review of addyosmani/agent-skills](docs/screenshot.png)

## Requirements

- Node 18+ and `git` on your PATH
- An Anthropic API key (billing is on your key)

## Setup

```bash
npm install
cp .env.example .env.local   # then put your key in .env.local
```

`.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```bash
npm run dev      # http://localhost:3000
# or
npm run build && npm start
```

Enter `owner/repo`, a full `https://github.com/owner/repo` URL, or two repos to
compare. Progress streams live; finished reports render in a sandboxed iframe and
appear in the sidebar.

## How it works

```
Browser ─ POST /api/jobs ─────────────► start an in-process job (concurrency 1)
        ─ GET  /api/jobs/[id]/events ──► SSE stream of progress
        ─ GET  /api/reports ──────────► list from data/index.json
        ─ GET  /api/reports/[id] ─────► serve data/reports/<id>.html
job runner ─► Agent SDK query() ─► loads .claude/skills/explore-repo ─► report
```

- `lib/analyze.ts` — wraps the Agent SDK `query()` call.
- `lib/jobs.ts` — in-process job registry + queue, streams progress events.
- `lib/store.ts` — `data/index.json` manifest + report files.
- `.claude/skills/explore-repo/` — **vendored copy** of the canonical skill from
  `~/.claude/skills/explore-repo/`. Re-copy it to pick up upstream changes.

## Notes

- Reports and the index live under `data/` and are gitignored.
- If the process restarts mid-job, that job is lost (acceptable for a local app);
  completed reports persist on disk.
