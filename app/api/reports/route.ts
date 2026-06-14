import { NextResponse } from "next/server";
import { readIndex } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await readIndex());
}
