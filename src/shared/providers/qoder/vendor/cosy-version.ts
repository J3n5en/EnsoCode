import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Dynamic gateway COSY client identity.
 *
 * The gateway hands out a reduced model catalog to clients whose COSY
 * version lags the current Qoder CLI, so the identity has to track the
 * latest CLI release. The source of truth is the same releases feed the
 * public changelog page (qoder.com/changelog?type=cli) reads:
 * a GitHub-shaped API over the QoderAI/changelog-CLI repo, served via
 * repo.qoder.com. The resolved version is cached on disk next to the
 * model catalog cache and refreshed at most once a day; any failure
 * (offline, bad payload, older tag) falls back to the bundled version
 * below, so request signing never depends on this fetch succeeding.
 */
export const BUNDLED_GATEWAY_COSY_VERSION = "1.1.72";
export const QODER_CLI_RELEASES_URL = "https://repo.qoder.com/repos/QoderAI/changelog-CLI/releases?per_page=5&page=1";

const CACHE_FILE = "qoder-cosy-version-cache.json";
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

interface CosyVersionCache {
  version?: string;
  checkedAt?: number;
}

interface CliRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

function getHomeDir(): string {
  // Prefer process.env.HOME so vitest setup can isolate caches (same
  // pattern as catalog.ts).
  if (!process.env.PI_CODING_AGENT_DIR) throw new Error("PI_CODING_AGENT_DIR is required for Qoder");
  return process.env.PI_CODING_AGENT_DIR;
}

function getCosyVersionCachePath(): string {
  return join(getHomeDir(), CACHE_FILE);
}

/** In-memory cache keyed by absolute cache path (HOME-safe across tests). */
const cosyVersionMem = new Map<string, CosyVersionCache | null>();

/** Clear the process-memory version cache (also used by tests). */
export function clearCosyVersionMemCache(): void {
  cosyVersionMem.clear();
}

function readCosyVersionCache(): CosyVersionCache | null {
  const cachePath = getCosyVersionCachePath();
  if (cosyVersionMem.has(cachePath)) {
    return cosyVersionMem.get(cachePath) ?? null;
  }
  if (!existsSync(cachePath)) {
    cosyVersionMem.set(cachePath, null);
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf8")) as CosyVersionCache;
    cosyVersionMem.set(cachePath, data);
    return data;
  } catch {
    cosyVersionMem.set(cachePath, null);
    return null;
  }
}

function writeCosyVersionCache(data: CosyVersionCache): void {
  const cachePath = getCosyVersionCachePath();
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // A read-only home must not break requests; the in-memory copy below
    // still serves this process.
  }
  cosyVersionMem.set(cachePath, data);
}

export function isCliVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}

/** Numeric semver-ish comparison for plain x.y.z versions. */
export function compareCliVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * The COSY version to sign requests with right now: the newest cached
 * CLI release when it is ahead of the bundled fallback, otherwise the
 * bundled fallback. Synchronous and network-free; refresh happens in
 * refreshGatewayCosyVersion().
 */
export function getGatewayCosyVersion(): string {
  const cached = readCosyVersionCache()?.version;
  if (isCliVersion(cached) && compareCliVersions(cached, BUNDLED_GATEWAY_COSY_VERSION) >= 0) {
    return cached;
  }
  return BUNDLED_GATEWAY_COSY_VERSION;
}

let refreshInFlight: Promise<void> | null = null;

/**
 * Fetch the latest Qoder CLI release tag and cache it when it is newer
 * than the version currently in use. Throttled to one check per day via
 * the cache's checkedAt stamp, deduplicated while in flight, and fully
 * failure-tolerant: it never throws and never downgrades the identity.
 */
export async function refreshGatewayCosyVersion(options?: { force?: boolean; now?: number }): Promise<void> {
  const now = options?.now ?? Date.now();
  const checkedAt = readCosyVersionCache()?.checkedAt;
  if (!options?.force && typeof checkedAt === "number" && now - checkedAt < REFRESH_INTERVAL_MS) {
    return;
  }
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let releases: unknown;
      try {
        const response = await fetch(QODER_CLI_RELEASES_URL, {
          headers: { Accept: "application/vnd.github.v3+json" },
          signal: controller.signal,
        });
        if (!response.ok) return;
        releases = await response.json();
      } finally {
        clearTimeout(timer);
      }
      if (!Array.isArray(releases)) return;
      const latest = (releases as CliRelease[]).find(
        (release) => release && !release.draft && !release.prerelease && isCliVersion(release.tag_name),
      );
      const stampedAt = Date.now();
      if (latest && compareCliVersions(latest.tag_name as string, getGatewayCosyVersion()) > 0) {
        writeCosyVersionCache({ version: latest.tag_name as string, checkedAt: stampedAt });
      } else {
        writeCosyVersionCache({ version: readCosyVersionCache()?.version, checkedAt: stampedAt });
      }
    } catch {
      // Offline or a bad payload: keep signing with the cached/bundled
      // version and try again on the next refresh window.
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}
