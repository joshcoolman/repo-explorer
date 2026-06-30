import { NextRequest, NextResponse } from "next/server";
import { cancelJob } from "@/lib/jobs";

export const runtime = "nodejs";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const cancelled = cancelJob(id);
  if (!cancelled) {
    return NextResponse.json(
      { error: "Job not found or already finished" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
