#!/usr/bin/env node
// One-command setup + run for Repo Explorer: `pnpm launch`.
//
// Runs from a BARE checkout — before `pnpm install` — so the top of this file uses
// only Node built-ins (no node_modules imports). The polished prompts come from
// `@inquirer/prompts`, loaded via dynamic import *after* deps are installed, so the
// fresh-clone "one command" property is preserved while the feel matches gimme-image.
//
// Flow: 1/4 prerequisites → 2/4 dependencies → 3/4 Anthropic key → 4/4 launch.

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
process.chdir(root);

const envExample = path.join(root, ".env.example");
const envLocal = path.join(root, ".env.local");
const nodeModules = path.join(root, "node_modules");
const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const STEPS = 4;

// ── tiny ANSI helpers ────────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  dim: (s) => paint("2", s),
  bold: (s) => paint("1", s),
  red: (s) => paint("31", s),
  green: (s) => paint("32", s),
  yellow: (s) => paint("33", s),
  blue: (s) => paint("34", s),
  cyan: (s) => paint("36", s),
};
const ok = (s) => console.log(`  ${c.green("✓")} ${s}`);
const info = (s) => console.log(`  ${c.dim("•")} ${s}`);
const warn = (s) => console.log(`  ${c.yellow("!")} ${s}`);
const die = (s) => {
  console.error(`\n  ${c.red("✗")} ${s}\n`);
  process.exit(1);
};

function step(n, title) {
  const line = `── ${n}/${STEPS}  ${title} `;
  console.log(`\n${c.cyan(line + "─".repeat(Math.max(0, 48 - line.length)))}\n`);
}

function banner() {
  const w = 40;
  const title = "repo-explorer launcher";
  const pad = Math.floor((w - title.length) / 2);
  const mid = " ".repeat(pad) + title + " ".repeat(w - title.length - pad);
  const top = "┌" + "─".repeat(w) + "┐";
  const bot = "└" + "─".repeat(w) + "┘";
  console.log("\n" + c.cyan(top));
  console.log(c.cyan("│") + c.bold(mid) + c.cyan("│"));
  console.log(c.cyan(bot));
  console.log(c.dim("  local architectural reviews · runs on your Anthropic key\n"));
}

// Spinner for short async work with no other output (e.g. the key-validation ping).
async function withSpinner(label, fn) {
  if (!process.stdout.isTTY) {
    process.stdout.write(`  ${label}…`);
    try {
      const r = await fn();
      console.log(" done");
      return r;
    } catch (e) {
      console.log(" failed");
      throw e;
    }
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r  ${c.cyan(frames[i++ % frames.length])} ${label}…`);
  }, 80);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    process.stdout.write("\r\x1b[K");
  }
}

// @inquirer/prompts — available only after deps are installed; load lazily.
let prompts;
async function loadPrompts() {
  if (prompts) return prompts;
  try {
    prompts = await import("@inquirer/prompts");
  } catch {
    warn("prompt library not found — installing dependencies first…");
    if ((await spawnInherit("pnpm", ["install"])) !== 0) {
      die("`pnpm install` failed. Fix the errors above and re-run `pnpm launch`.");
    }
    prompts = await import("@inquirer/prompts");
  }
  return prompts;
}

// ── port / process helpers ───────────────────────────────────────────────────
function portInUse(port, host = "127.0.0.1", timeout = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (inUse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false)); // ECONNREFUSED → free
    socket.connect(port, host);
  });
}

async function nextFreePort(start) {
  for (let p = start; p < start + 50; p++) {
    if (!(await portInUse(p))) return p;
  }
  return null;
}

async function getHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.app === "repo-explorer" ? data : null;
  } catch {
    return null;
  }
}

function whoHasPort(port) {
  try {
    const out = execFileSync("lsof", ["-i", `:${port}`, "-sTCP:LISTEN", "-P", "-n"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.trim().split("\n")[1]; // skip header row
    if (!line) return null;
    const [command, pid] = line.split(/\s+/);
    return { command, pid: Number(pid) };
  } catch {
    return null;
  }
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    }).unref();
  } catch {
    /* user can click the printed URL */
  }
}

// Discard anything already queued on stdin (e.g. the extra lines of an oversized
// paste) so the next prompt isn't pre-filled with leftover characters.
function flushStdin() {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    const discard = () => {};
    stdin.on("data", discard);
    stdin.resume();
    setTimeout(() => {
      stdin.removeListener("data", discard);
      stdin.pause();
      resolve();
    }, 50);
  });
}

function spawnInherit(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

// ── steps ────────────────────────────────────────────────────────────────────
function preflight() {
  step(1, "Prerequisites");

  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 20 || (maj === 20 && min < 9)) {
    die(`Node ${process.versions.node} found — Repo Explorer needs Node 20.9+.`);
  }
  ok(`Node ${process.versions.node}`);

  try {
    execFileSync("pnpm", ["--version"], { stdio: "ignore" });
    ok("pnpm");
  } catch {
    die("pnpm not found on PATH. Install it (e.g. `corepack enable`) and re-run `pnpm launch`.");
  }

  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    ok("git");
  } catch {
    warn("git not found on PATH — the explore-repo skill needs it to clone repos. Install git.");
  }
}

async function ensureDeps() {
  step(2, "Dependencies");
  if (fs.existsSync(nodeModules)) {
    ok("node_modules present — skipping install");
    return;
  }
  info("running `pnpm install`");
  if ((await spawnInherit("pnpm", ["install"])) !== 0) {
    die("`pnpm install` failed. Fix the errors above and re-run `pnpm launch`.");
  }
  ok("dependencies installed");
}

function readConfiguredKey() {
  if (!fs.existsSync(envLocal)) return null;
  const m = fs.readFileSync(envLocal, "utf8").match(/^ANTHROPIC_API_KEY=(.+)$/m);
  return m && m[1].trim() ? m[1].trim() : null;
}

async function validateKey(key) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 200) return { ok: true };
    if (res.status === 401) return { ok: false, reason: "the key was rejected (401 Unauthorized)" };
    return { ok: false, reason: `unexpected response (HTTP ${res.status})` };
  } catch {
    return { ok: null, reason: "couldn't reach api.anthropic.com (offline?)" };
  }
}

async function configureKey() {
  step(3, "Anthropic API key");

  if (readConfiguredKey()) {
    ok(".env.local already has ANTHROPIC_API_KEY — skipping");
    return;
  }

  const { input, confirm } = await loadPrompts();
  info("Billing runs on this key. It's written to .env.local and never leaves your machine.");
  info("Get one at https://console.anthropic.com/ → API keys.\n");

  for (;;) {
    // Drain any characters left in the buffer from a previous paste (a key with a
    // trailing newline leaves extra bytes queued) so the retry prompt starts empty.
    await flushStdin();
    const key = (
      await input({
        message: "Paste your ANTHROPIC_API_KEY:",
        validate: (v) => (v.trim().length > 0 ? true : "Paste a key, or Ctrl-C to abort."),
      })
    ).trim();

    if (!key.startsWith("sk-ant-")) {
      warn("That doesn't look like an Anthropic key (expected an `sk-ant-` prefix).");
    }

    const result = await withSpinner("verifying key", () => validateKey(key));
    if (result.ok === true) {
      ok("key verified");
      writeEnvLocal(key);
      return;
    }
    if (result.ok === null) {
      warn(result.reason);
      if (await confirm({ message: "Use this key anyway?", default: false })) {
        writeEnvLocal(key);
        return;
      }
      continue;
    }
    warn(`${result.reason} — let's try another key.`);
  }
}

function writeEnvLocal(key) {
  let tmpl = fs.existsSync(envExample)
    ? fs.readFileSync(envExample, "utf8")
    : "ANTHROPIC_API_KEY=\n";
  if (/^ANTHROPIC_API_KEY=.*$/m.test(tmpl)) {
    tmpl = tmpl.replace(/^ANTHROPIC_API_KEY=.*$/m, `ANTHROPIC_API_KEY=${key}`);
  } else {
    tmpl += `\nANTHROPIC_API_KEY=${key}\n`;
  }
  fs.writeFileSync(envLocal, tmpl);
  ok(".env.local written (gitignored)");
}

// Poll the new server, then open the browser once it answers.
async function openWhenReady(port, url) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await getHealth(port)) {
      console.log(`\n  ${c.green("✓")} ${c.bold("Repo Explorer is live:")} ${c.blue(url)}`);
      openBrowser(url);
      return;
    }
  }
}

function startServer(port) {
  const url = `http://localhost:${port}`;
  info(`starting dev server → ${c.blue(url)} ${c.dim("(Ctrl-C to stop)")}`);
  openWhenReady(port, url); // fire-and-forget; runs alongside the server
  const child = spawn("pnpm", ["exec", "next", "dev", "-p", String(port)], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => die(`Failed to start dev server: ${err.message}`));
}

function pointAt(port) {
  const url = `http://localhost:${port}`;
  console.log(`\n  ${c.green("✓")} ${c.bold("Repo Explorer is already running:")} ${c.blue(url)}`);
  openBrowser(url);
  process.exit(0);
}

async function launch(port) {
  step(4, "Launch");

  if (!(await portInUse(port))) {
    ok(`port ${port} is free`);
    return startServer(port);
  }

  const { select } = await loadPrompts();

  // Something's on the port. Is it us?
  const health = await getHealth(port);
  if (health) {
    if (path.resolve(health.dir) === root) {
      ok(`an instance of Repo Explorer (this folder) is already on :${port}`);
      return pointAt(port);
    }
    warn(`another Repo Explorer instance (from ${c.dim(health.dir)}) is on :${port}.`);
    const choice = await select({
      message: "What do you want to do?",
      choices: [
        { name: "Open the running instance", value: "open" },
        { name: "Launch this one on a different port", value: "diff" },
        { name: "Cancel", value: "cancel" },
      ],
    });
    if (choice === "open") return pointAt(port);
    if (choice === "cancel") process.exit(0);
    return startServer(await pickFreePort(port));
  }

  // Foreign process on the port.
  const who = whoHasPort(port);
  const owner = who ? `${c.bold(who.command)} (pid ${who.pid})` : "another process";
  warn(`port ${port} is in use by ${owner} — not Repo Explorer.`);
  const choice = await select({
    message: "What do you want to do?",
    choices: [
      { name: `Kill ${who ? who.command : "it"} and use port ${port}`, value: "kill" },
      { name: "Use a different port", value: "diff" },
      { name: "Cancel", value: "cancel" },
    ],
  });

  if (choice === "cancel") process.exit(0);

  if (choice === "kill") {
    if (!who) die("Couldn't identify the process holding the port (no lsof?). Pick a different port.");
    try {
      process.kill(who.pid);
    } catch (e) {
      die(`Couldn't kill pid ${who.pid}: ${e.message}`);
    }
    for (let i = 0; i < 20; i++) {
      if (!(await portInUse(port))) {
        ok(`freed port ${port}`);
        return startServer(port);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    die(`Port ${port} is still busy after killing pid ${who.pid}.`);
  }

  return startServer(await pickFreePort(port));
}

async function pickFreePort(from) {
  const free = await nextFreePort(from + 1);
  if (!free) die(`Couldn't find a free port near ${from}.`);
  info(`using port ${free} instead`);
  return free;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  banner();
  preflight();
  await ensureDeps();
  await configureKey();
  await launch(DEFAULT_PORT);
}

main().catch((e) => {
  // Ctrl-C out of an inquirer prompt → exit quietly, not as a crash.
  if (e && (e.name === "ExitPromptError" || e.name === "AbortPromptError")) {
    console.log(`\n  ${c.dim("aborted.")}\n`);
    process.exit(130);
  }
  die(e?.message || String(e));
});
