---
name: create-persona
description: Scaffold a new analysis-persona skill for repo-explorer — a variant of explore-repo with a different investigation scope and report template, sharing the same clone/citation/output mechanics. Interviews the user about scope, report structure, and voice, then writes .claude/skills/<slug>/{SKILL.md,template.html} and registers it in .claude/skills/personas.json. Use when the user wants to add a new analysis persona (e.g. "create a security-audit persona", "I want a persona that focuses on test coverage").
user_invocable: true
invocation_hint: /create-persona <short description of the new persona>
---

# create-persona

Scaffold a new **persona** — a variant of the `explore-repo` skill with its own investigation scope and report template, selectable in the repo-explorer web app's persona dropdown. Personas share the same mechanical rules (cloning, citations, output handling, hard rules) so they behave predictably; they differ in what they look at and how they present it.

## 1. Read `explore-repo` first — don't re-derive

Before writing anything, read `.claude/skills/explore-repo/SKILL.md` in full. It is the canonical source for every **mechanical** section below — copy the actual text into the new skill (substituting only the skill's own name where `explore-repo` appears in prose), never paraphrase from memory:

- **Modes** (single vs comparison parsing)
- **Classify each source** / **Resolve sources**
- **Remote sources** (shallow-clone, SHA capture, failure handling)
- **Output file** rules (never-overwrite suffixing)
- **Citations** (local plain-text vs SHA-pinned remote blob links)
- **Process** steps (retouch step numbers only if the Investigation/Report-structure step count changes)
- **Keep prompt**
- **Hard rules** — especially never-overwrite, always-discard-clone-unless-kept, single self-contained HTML file, no emojis in the HTML body

This is the anti-drift mechanism: a future fix to `explore-repo`'s mechanical rules won't auto-propagate to personas, but no persona should *invent* a divergent version of those rules at authoring time either.

These sections vary per persona and are **not** copied — they're built from the interview in step 2:

- **Investigation** (explore-repo's 7-point scope list)
- **Report structure** (explore-repo's 8-section single-repo / 7-section comparison lists)
- **App ideas section** (explore-repo-specific; include only if the new persona wants an equivalent)
- **HTML / CSS style** (only the parts that diverge — default to reusing explore-repo's CSS variables and component classes)
- **Voice**

## 2. Interview the user

Ask explicitly — don't silently assume defaults for anything that changes the persona's actual output, but offer `explore-repo`'s content as the starting point for each question so the user can react to something concrete instead of a blank prompt:

1. **Slug** — kebab-case folder/skill name (e.g. `security-audit`). Check `.claude/skills/<slug>/` doesn't already exist; if it does, ask for a different one.
2. **Label** — short human-friendly name for the registry/selector (e.g. "Security Audit").
3. **Description** — one sentence covering both the registry entry and the SKILL.md frontmatter `description`. The frontmatter description is what Claude Code uses to decide when to auto-invoke the skill from natural language, so follow `explore-repo`'s shape: what it produces + "Use when…" + 1-2 example invocations.
4. **Investigation scope** — what should the Explore subagent look for? Show `explore-repo`'s 7-point list (high-level shape / backend patterns / frontend patterns / cross-cutting concerns / patterns worth highlighting / concerns & red flags / what the app does) and ask what to keep, drop, reweight, or add.
5. **Report structure** — the section list for single-repo mode (and comparison mode too, if the persona should support it). Show `explore-repo`'s lists as a starting diff.
6. **Voice** — ask if tone should differ from `explore-repo`'s "terse, declarative, opinionated" voice. Default: reuse it verbatim if not specified.
7. **Visual template** — ask if the persona needs new component classes beyond `explore-repo`'s `.grid` / `.card` / `.pill.good|warn|bad|neutral` / `.callout` / `.filepath` vocabulary (e.g. a severity scorecard for a security persona). Default: reuse `template.html`'s CSS variables and component classes unchanged, for visual consistency across personas, unless there's a real reason to diverge.

## 3. Scaffold the folder

```
mkdir .claude/skills/<slug>
```

Write `.claude/skills/<slug>/SKILL.md`:
- New frontmatter: `name: <slug>`, the interviewed description, `user_invocable: true`, `invocation_hint: /<slug> <path|url> [and compare with <path|url>]`.
- Body: the mechanical sections copied verbatim from `explore-repo/SKILL.md` (substituting the skill name in prose), with **Investigation**, **Report structure**, **Voice**, and (if changed) **HTML / CSS style** replaced by the interview's answers. Keep the closing **Reference template** section, pointing at `template.html` "next to this file" — same convention as `explore-repo`.

Write `.claude/skills/<slug>/template.html`:
- Start from a copy of `.claude/skills/explore-repo/template.html`.
- If the interview asked for new component classes, append them following the existing CSS variable/class naming conventions. Otherwise leave unchanged.

## 4. Register it

Read `.claude/skills/personas.json`, append (never edit or reorder existing entries) one new entry:

```json
{ "id": "<slug>", "skillFolder": "<slug>", "label": "<label>", "description": "<description>" }
```

Write it back with 2-space indentation and a trailing newline.

## 5. Verify

- Confirm `personas.json` still parses as valid JSON.
- Spot-check the new `SKILL.md`'s Hard Rules section retained the clone-discard and never-overwrite rules.
- Tell the user the persona is selectable in the repo-explorer app immediately — the app's `/api/personas` route reads the registry fresh on every request, so no restart is needed, just a browser refresh if the tab was already open.

## Hard rules for this meta-skill

- Never modify `.claude/skills/explore-repo/` while authoring a new persona.
- Only append to `personas.json` — never edit or remove existing entries.
- The new persona's `SKILL.md` must be fully self-contained. No "see explore-repo for X" cross-references — `explore-repo` may change independently later and a persona shouldn't silently inherit drift it never reviewed.
- New persona folders are git-tracked and local to this repo clone, same as `explore-repo` itself. If the user wants a persona available globally in `~/.claude/skills/` too, that's a manual copy they do themselves afterward — the inverse direction of how `explore-repo` was originally vendored into this project.
