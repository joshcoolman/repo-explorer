import { NextRequest, NextResponse } from "next/server";
import { startJob } from "@/lib/jobs";
import { findExistingReport } from "@/lib/store";

export const runtime = "nodejs";

function isValidRepoRef(ref: string): boolean {
  if (/^(https?:\/\/|git@)/.test(ref)) return true;
  // bare owner/repo shorthand (the skill normalizes this to a GitHub URL)
  return /^[\w.-]+\/[\w.-]+$/.test(ref);
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = (body as { urls?: unknown })?.urls;
  if (!Array.isArray(raw)) {
    return NextResponse.json({ error: "Provide urls: string[]" }, { status: 400 });
  }

  const urls = raw
    .map((u) => (typeof u === "string" ? u.trim() : ""))
    .filter(Boolean);

  if (urls.length < 1 || urls.length > 2) {
    return NextResponse.json(
      { error: "Provide one or two repository URLs" },
      { status: 400 },
    );
  }

  for (const u of urls) {
    if (!isValidRepoRef(u)) {
      return NextResponse.json(
        { error: `Not a valid repo URL or owner/repo: ${u}` },
        { status: 400 },
      );
    }
  }

  const rawSteering = (body as { steeringText?: unknown })?.steeringText;
  // No length cap — long, detailed steering is encouraged.
  const steeringText = typeof rawSteering === "string" ? rawSteering.trim() : "";

  const rawModel = (body as { model?: unknown })?.model;
  const model = typeof rawModel === "string" && rawModel.trim() ? rawModel.trim() : undefined;

  // Analysis is keyed by repo: if this repo was already analyzed, surface the
  // existing report so the UI can offer "follow-up" vs "delete & start over".
  const force = (body as { force?: unknown })?.force === true;
  if (!force) {
    const existing = await findExistingReport(urls);
    if (existing) {
      return NextResponse.json({ existing }, { status: 409 });
    }
  }

  const meta = await startJob(urls, steeringText || undefined, model);
  return NextResponse.json(meta, { status: 201 });
}
