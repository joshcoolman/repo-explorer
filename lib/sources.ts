export interface RepoRef {
  url: string; // canonical web URL, e.g. https://github.com/owner/repo
  label: string; // e.g. owner/repo
}

/** Sentinel so we never inject the source banner twice. */
export const SOURCE_MARKER = "repo-explorer-source";

/** Normalize a stored repo reference into a clean web URL + owner/repo label. */
export function toRepoRef(input: string): RepoRef {
  let s = input.trim().replace(/\.git$/i, "");

  // git@host:owner/repo  ->  https://host/owner/repo
  const ssh = s.match(/^git@([^:]+):(.+)$/);
  if (ssh) s = `https://${ssh[1]}/${ssh[2]}`;

  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length >= 2) {
        return {
          url: `${u.protocol}//${u.host}/${segs[0]}/${segs[1]}`,
          label: `${segs[0]}/${segs[1]}`,
        };
      }
      return { url: s, label: segs.join("/") || u.hostname };
    } catch {
      return { url: s, label: s };
    }
  }

  // bare owner/repo shorthand -> GitHub
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) {
    return { url: `https://github.com/${s}`, label: s };
  }

  return { url: s, label: s };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A styled "Source:" banner for injection into report HTML (after <body>). */
export function sourceBannerHtml(repos: string[]): string {
  const refs = repos.map(toRepoRef);
  if (refs.length === 0) return "";
  const links = refs
    .map(
      (r) =>
        `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" style="color:#8ab4ff;text-decoration:none">${escapeHtml(r.label)}</a>`,
    )
    .join(" &nbsp;·&nbsp; ");
  return `<!--${SOURCE_MARKER}--><div style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:#9aa3b2;background:#0b0d13;border-bottom:1px solid #2a2f40;padding:10px 16px">Source: ${links}</div>`;
}
