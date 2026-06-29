// Lightweight signature endpoint so the launcher (scripts/launch.mjs) can tell
// whether a process holding the dev port is *this* repo-explorer instance.
export async function GET() {
  return Response.json({ app: "repo-explorer", dir: process.cwd(), pid: process.pid });
}
