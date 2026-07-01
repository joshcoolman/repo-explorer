import { NextResponse } from "next/server";
import { readPersonas } from "@/lib/personas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await readPersonas());
}
