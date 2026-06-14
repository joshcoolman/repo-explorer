import { NextRequest } from "next/server";
import { getJob, subscribe } from "@/lib/jobs";
import type { ProgressEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) return new Response("Job not found", { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: ProgressEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));

      // Replay everything buffered so far so a late subscriber catches up.
      for (const ev of job.events) send(ev);
      if (job.done) {
        controller.close();
        return;
      }

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        unsub();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const unsub = subscribe(id, (ev) => {
        if (closed) return;
        send(ev);
        if (ev.type === "done") close();
      });

      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
