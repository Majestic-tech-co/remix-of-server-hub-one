// Finding the newest Fleet desktop installer among GitHub releases, and checking download links.
// Pure functions (no network) so they are easy to test; the route does the fetching.
import { compareVersions, parseVersion } from "./semver";

export interface GhAsset {
  name: string;
  size: number;
  /** GitHub API URL of the asset (not the browser download URL). */
  url: string;
}
export interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GhAsset[];
}
export interface LatestInstaller {
  version: string;
  asset: GhAsset;
}

const TAG = /^desktop-v(\d+\.\d+\.\d+)$/;
const INSTALLER = /^Fleet-Setup-(\d+\.\d+\.\d+)\.exe$/;

/**
 * The highest-versioned published release whose tag is `desktop-vX.Y.Z` and which contains the matching
 * `Fleet-Setup-X.Y.Z.exe`. Drafts, pre-releases, other tags and mismatched assets are ignored.
 */
export function pickLatestInstaller(releases: GhRelease[]): LatestInstaller | null {
  let best: LatestInstaller | null = null;
  for (const r of releases) {
    if (r.draft || r.prerelease) continue;
    const tag = TAG.exec(r.tag_name);
    if (!tag) continue;
    const asset = r.assets.find((a) => INSTALLER.exec(a.name)?.[1] === tag[1]);
    if (!asset || !parseVersion(tag[1])) continue;
    if (!best || compareVersions(tag[1], best.version) > 0) best = { version: tag[1], asset };
  }
  return best;
}

/**
 * GitHub answers an authenticated asset request with a redirect to a short-lived signed URL. Only hand the
 * browser an https link on GitHub's own download hosts (never whatever a redirect happens to say).
 */
export function isSafeDownloadUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return h === "github.com" || h.endsWith(".github.com") || h === "githubusercontent.com" || h.endsWith(".githubusercontent.com");
}
