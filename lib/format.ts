export function fmtDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return "";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function fmtCost(usd: number | undefined): string {
  if (usd == null) return "";
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}
