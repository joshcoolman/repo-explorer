---
name: explore-repo
description: Produce a learning-oriented architectural review of a repo as a single-file HTML report. Works on a local path OR a remote URL (shallow-cloned, then optionally discarded). Use when the user wants to understand a codebase's patterns, vet it for porting, or compare two repos side by side. Examples — "/explore-repo ~/repos/mike", "/explore-repo https://github.com/owner/repo", "/explore-repo tell me about ~/repos/sandbox", "/explore-repo ~/repos/genzen and compare with https://github.com/owner/repo".
user_invocable: true
invocation_hint: /explore-repo <path|url> [and compare with <path|url>]
---

# explore-repo

Read one or two repos and produce a polished, dependency-free HTML report at `~/repos/<name>.html` that the user can open in a browser. The focus is **learning and pattern-spotting**, not nitpicking style.

## Modes

The user's argument is a natural-language string. Parse it:

- **Single-repo mode** — one source is mentioned (e.g. `~/repos/mike`, `tell me about ~/repos/sandbox`, `https://github.com/owner/repo`). Produce a deep review of that repo alone.
- **Comparison mode** — two sources are mentioned and the phrasing implies comparison (`compare with`, `vs`, `and ~/repos/...`, `against`). Treat the first as the primary subject; the second is the lens/reference repo. The two sources can mix freely: local↔URL, URL↔URL, or local↔local.

### Classify each source

Classify each side independently:

- **Local path** — `~/...`, an absolute path, or a relative path. Verify it exists with `test -d`.
- **Remote URL** — starts with `https://`, `http://`, or `git@` (GitHub, GitLab, Bitbucket).
- **`owner/repo` shorthand** — bare `owner/repo` with no leading path marker → treat as `https://github.com/owner/repo`.

If a local path doesn't exist on disk, stop and tell the user — do not invent contents.

### Resolve sources

Before investigating, materialize every remote source to a local directory (see **Remote sources** below). Local sources are used in place. Track for each source: its local working dir (fed to the Explore subagent), and — for remotes — the origin URL, host, and pinned commit SHA (for citations) plus an is-remote flag (drives the keep prompt and cleanup).

## Remote sources

A shallow clone is **fully comprehensive for this skill**: `git clone --depth 1` pulls every file's complete contents at HEAD. The only thing it omits is git history, which this skill never reads. So treat a URL as sugar for "clone it, analyze it, then ask whether to keep it."

For each remote source:

1. Derive `owner`, `repo`, and a clean `<name>` (the repo basename) for the output filename.
2. Shallow-clone into a temp dir:
   ```
   tmp=$(mktemp -d); git clone --depth 1 --single-branch "<url>" "$tmp/<name>"
   ```
3. Resolve the pinned SHA for citations: `git -C "$tmp/<name>" rev-parse HEAD`.
4. On clone failure (bad URL, private repo with no credentials, network error), `rm -rf "$tmp"`, stop, and tell the user plainly — do **not** invent contents. Private repos rely on the user's existing git / `gh` auth. Submodules are not fetched by `--depth 1`; note it if a repo leans heavily on them.

The clone may be discarded after the run (see **Keep prompt**), so cite remote code with SHA-pinned links (see **Citations**) — never with the temp path.

## Output file

- Always write into `~/repos/`.
- Filename uses each source's basename — for a remote, the repo name from the URL:
  - Single: `<repo-name>-analysis.html` (e.g. `mike-analysis.html`)
  - Comparison: `<primary>-vs-<reference>.html` (e.g. `mike-vs-genzen.html`)
- **Never overwrite.** If the file exists, append `-2`, `-3`, … before `.html` until you find a free name (`mike-analysis-2.html`). Check with `ls` or `test -e` before writing.
- Single HTML file, all CSS embedded in a `<style>` block. No external fonts, no CDN links, no JS dependencies. Must open offline.

## Investigation

The repos can be large. **Delegate the read-through to an `Explore` subagent** with a "very thorough" breadth. Doing this in the main conversation will burn context unnecessarily.

Prompt the subagent to report on:

1. **High-level shape** — backend stack, frontend stack, how they communicate, deployment targets.
2. **Backend patterns** — language/framework, API design, data layer, auth, background jobs, external integrations, notable abstractions. Cite file paths.
3. **Frontend patterns** — framework, state management, routing, API client, component organization, auth flow, notable libraries.
4. **Cross-cutting concerns** — auth, error handling, logging, testing, CI, deployment, env management.
5. **Patterns worth highlighting** — clever abstractions, reusable patterns, well-designed pieces. Be specific about *why* each is interesting.
6. **Concerns / red flags** — coupling, security issues, scalability problems, anything that wouldn't port well.
7. **What the app actually DOES** at a product level, inferred from code (not the README).

In comparison mode, run the same investigation on the reference repo (a second Explore subagent — launch both in parallel) so the comparison rests on real reading, not assumptions.

Always require **repo-relative file paths with line numbers** for every claim. The user navigates from these, and the relative path is what gets turned into a citation (plain text for local sources, a blob link for remotes).

## Citations

Render every file reference based on whether its source is local or remote:

- **Local source** — plain `path:line` text, as `<span class="filepath">backend/src/lib/llm/claude.ts:42</span>`.
- **Remote source** — a clickable link pinned to the resolved SHA, with the visible text still `path:line`:
  - GitHub: `https://github.com/<owner>/<repo>/blob/<sha>/<path>#L<line>` (use `#L<start>-L<end>` for ranges).
  - GitLab: `https://gitlab.com/<owner>/<repo>/-/blob/<sha>/<path>#L<line>`.
  - Unknown host: fall back to plain text.
  - Markup: `<span class="filepath"><a href="…#L42">backend/src/lib/llm/claude.ts:42</a></span>`.

Pinning to the SHA keeps the links permanent and means the report stays navigable even after the local clone is discarded.

## Report structure

### Single-repo report

1. The shape of the app
2. Backend patterns
3. Frontend patterns
4. Cross-cutting concerns
5. Patterns worth stealing (grid of cards)
6. Concerns & red flags (callout boxes)
7. App ideas built on this skeleton — see below
8. Key file map (tables)

### Comparison report

1. The shape of each app (side by side)
2. Where they agree
3. Where they differ (in style, in topology, in tooling)
4. Patterns from `<primary>` worth porting to `<reference>` (table with verdicts)
5. Patterns from `<reference>` worth porting to `<primary>` (table with verdicts)
6. Shared concerns
7. Key file maps for both

## App ideas section (single-repo mode only)

Always include a section sketching apps that could be built on the same skeleton. Organize by *how much of the original you keep*:

- **Closest fork** — keep the data model and most of the UI, swap the domain.
- **Medium fork** — keep the engine (auth, tool loop, storage, streaming) and the shape of the core interactions, redesign the data model.
- **Far fork** — keep only the bones (auth + storage + LLM adapter) and rebuild.

Aim for 3–4 ideas per tier. Each idea is a card with: a name, a 2–3 sentence description, and a "reuses" line listing which primitives from the source repo it leans on. Lead with the user's domain interests if they've expressed any (check memory for projects like genzen, sandbox).

Close the ideas section with one synthesis callout: "the thread running through all of these is X" — naming the underlying primitives that make the skeleton portable.

## HTML / CSS style

Match this house style — it's the look that worked in `mike-analysis.html`:

- Dark theme. Variables: `--bg:#0f1115`, `--panel:#161922`, `--border:#2a2f40`, `--text:#e6e8ef`, `--muted:#9aa3b2`, `--accent:#8ab4ff`, `--accent-2:#b08aff`, `--good:#6dd58c`, `--warn:#f0b85a`, `--bad:#f08a8a`, `--code-bg:#0b0d13`.
- Max content width 980px, generous padding, system font stack with JetBrains Mono / SF Mono for code.
- Header with a small uppercase eyebrow, large title, muted lede paragraph.
- Sticky-feeling table of contents with anchor links.
- Cards in 2-column grids for patterns and app ideas.
- Pills with `.good` / `.warn` / `.bad` / `.neutral` variants for verdicts.
- Callout boxes with a 4px left border, variant colors.
- Tables for file maps with monospace `.filepath` cells.
- Responsive: collapse grids and TOC columns at 720px.
- No emojis in copy. Pills carry the visual signal.

A reference template is included at the bottom of this skill — adapt it, don't reinvent the styling each run.

## Voice

- Terse, declarative, opinionated. The user is learning — give them takes, not encyclopedia entries.
- Reference specific files by path. `<span class="filepath">backend/src/lib/llm/claude.ts</span>` style.
- When something is clever, say *why* in one sentence.
- When something is a red flag, say *what would break* and *what's cheap to fix*.
- Don't pad with section intros. Get to the content.

## Process

1. Parse the user's argument — extract one or two sources, classify each (local path / remote URL / `owner/repo` shorthand), and detect comparison intent.
2. Resolve sources: verify each local path with `test -d`; shallow-clone each remote into a temp dir and capture its SHA (see **Remote sources**).
3. Decide the output filename. Run `ls ~/repos/<basename>*.html 2>/dev/null` to detect collisions; pick the next free suffix.
4. Launch Explore subagent(s) against the local working dirs — in parallel for comparison mode. Wait for results.
5. Synthesize the report. Do **not** dump the subagent output verbatim; rewrite into the house voice. Render citations per the **Citations** rule.
6. For single-repo mode, write the app-ideas section yourself based on the primitives surfaced. Check memory (`MEMORY.md`) for projects the user cares about — bias the closest-fork tier toward their domains.
7. Write the HTML file with the Write tool.
8. **Keep prompt** (remote sources only) — see below.
9. Report back: the filename, a one-sentence summary of what's inside, an `open` hint, and (if kept) where each clone landed.

## Keep prompt

After writing the report, for each remote source ask the user a simple y/n in chat: **"Keep a local clone of `<name>`?"** (in comparison mode with two remotes, ask per repo).

- **Yes** — promote it to `~/repos/<name>` (apply the never-overwrite suffix rule if it exists), best-effort fetch full history so the kept copy is a normal repo, then move it and clean up the temp dir:
  ```
  git -C "$tmp/<name>" fetch --unshallow 2>/dev/null
  mv "$tmp/<name>" ~/repos/<name>
  rm -rf "$tmp"
  ```
  Report the final path.
- **No** — `rm -rf "$tmp"`.

## Hard rules

- Never overwrite an existing file. Always pick a fresh suffix.
- Never write outside `~/repos/` (the report; a kept clone also lands in `~/repos/`).
- Output must be a single self-contained HTML file. No external assets.
- Use the Explore subagent for the read-through — don't crawl the repo from the main conversation.
- Cite file paths (and line numbers when possible) for every concrete claim. Remote sources get SHA-pinned blob links so the report survives deletion of the clone.
- Always `rm -rf` a temp clone unless the user chose to keep it; never leave a half-cloned dir behind on failure.
- A shallow clone is fully comprehensive for code analysis — it gives complete file contents and omits only git history, which this skill doesn't use.
- No emojis in the HTML body. Pills, callouts, and color carry the visual weight.
- If the user asks for a totally different output format (Markdown, plain text), follow that instead — these rules apply to the default HTML output.

## Reference template

A starter HTML skeleton with the house styling lives at `template.html` next to this file. Read it once at the start of a run and adapt it for the specific report. Re-creating the CSS from scratch each time is wasted effort and will drift.
