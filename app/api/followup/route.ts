import { NextRequest, NextResponse } from "next/server";
import { startFollowUp } from "@/lib/jobs";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const reportId = (body as { reportId?: unknown })?.reportId;
  if (typeof reportId !== "string" || !reportId.trim()) {
    return NextResponse.json({ error: "Provide reportId" }, { status: 400 });
  }

  const rawRequest = (body as { request?: unknown })?.request;
  const request =
    typeof rawRequest === "string" ? rawRequest.trim().slice(0, 500) : "";
  if (!request) {
    return NextResponse.json({ error: "Provide a follow-up request" }, { status: 400 });
  }

  const meta = await startFollowUp(reportId.trim(), request);
  if (!meta) {
    return NextResponse.json(
      { error: "Report not found or not finished yet" },
      { status: 404 },
    );
  }

  return NextResponse.json(meta, { status: 201 });
}
