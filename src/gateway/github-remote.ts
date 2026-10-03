/** Parse a GitHub remote in HTTPS, SSH URL, or scp-like form. */
export function parseGitHubRemoteUrl(raw: string): { owner: string; repo: string } | null {
  const trimmed = raw.trim();
  let path: string | undefined;
  const scpMatch = /^git@github\.com:(.+)$/i.exec(trimmed);
  if (scpMatch) {
    path = scpMatch[1];
  } else {
    const url = URL.parse(trimmed);
    if (
      !url ||
      !["https:", "http:", "ssh:"].includes(url.protocol) ||
      url.hostname.toLowerCase() !== "github.com"
    ) {
      return null;
    }
    path = url.pathname;
  }
  const segments = (path ?? "").split("/").filter(Boolean);
  const owner = segments[0];
  const repo = segments[1]?.replace(/\.git$/i, "");
  if (segments.length !== 2 || !owner || !repo) {
    return null;
  }
  return { owner, repo };
}
