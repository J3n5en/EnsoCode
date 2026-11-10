import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { getMachineId, QODER_CLIENT_TYPE, QODER_OPENAPI_COSY_VERSION } from "../cosy.js";
import { getQoderExchangeURL, getQoderRegionConfig, getQoderUserInfoURL, type QoderMode } from "../region.js";

const UA = "pi-provider-qoder";

/**
 * Marker prefix used in the credential `refresh` field to identify PAT-based
 * credentials. Layout: `pat|<personalToken>|<jobRefreshToken>|<userID>|<machineID>`
 */
export const PAT_REFRESH_PREFIX = "pat";

export interface PatExchangeResult {
  /** Short-lived job token (jt-...) used for auth + COSY signatures. */
  jobToken: string;
  /** Job refresh token (jrt-...), if returned. */
  jobRefreshToken: string;
  expiresAt: number;
}

export function isPatRefresh(refresh: string): boolean {
  return refresh.startsWith(`${PAT_REFRESH_PREFIX}|`);
}

/** Encode a PAT credential's refresh field. */
export function encodePatRefresh(pat: string, jobRefreshToken: string, userID: string, machineID: string): string {
  return [PAT_REFRESH_PREFIX, pat, jobRefreshToken, userID, machineID].join("|");
}

/** Decode a PAT credential's refresh field. */
export function decodePatRefresh(refresh: string): {
  pat: string;
  jobRefreshToken: string;
  userID: string;
  machineID: string;
} {
  const parts = refresh.split("|");
  return {
    pat: parts[1] || "",
    jobRefreshToken: parts[2] || "",
    userID: parts[3] || "",
    machineID: parts[4] || "",
  };
}

/**
 * Exchange a Qoder Personal Access Token (pt-...) for a short-lived Job Token
 * (jt-...). PATs cannot authenticate API calls directly; they must first be
 * exchanged. This mirrors the official qodercli/qoderclicn flow:
 *   POST /api/v1/jobToken/exchange { personal_token } -> { token, refresh_token, expires_at }
 * The exchange endpoint does not require a COSY signature.
 */
export async function exchangeJobToken(pat: string, mode: QoderMode, signal?: AbortSignal): Promise<PatExchangeResult> {
  let res: Response;
  try { res = await fetch(getQoderExchangeURL(mode), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
      "Cosy-Version": QODER_OPENAPI_COSY_VERSION,
      "Cosy-ClientType": QODER_CLIENT_TYPE,
    },
    body: JSON.stringify({ personal_token: pat }),
    redirect: "manual",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  }); } catch {
    if (signal?.aborted) throw new Error("Login cancelled");
    throw new Error("Qoder PAT exchange network error");
  }

  if (!res.ok) {
    throw new Error(`Qoder PAT exchange failed: ${res.status}`);
  }

  let data: { token?: string; refresh_token?: string; expires_at?: string; expires_in?: number };
  try { data = await res.json() as typeof data; } catch { throw new Error("Qoder PAT exchange returned invalid response"); }

  if (typeof data?.token !== "string" || !data.token.trim()) {
    throw new Error("Qoder PAT exchange returned no job token");
  }

  const now = Date.now();
  let expiresAt = now + 24 * 60 * 60 * 1000;
  if ("expires_in" in data) {
    if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 300000) throw new Error("Qoder PAT exchange returned invalid expiry");
    expiresAt = now + data.expires_in;
  }
  if ("expires_at" in data) {
    if (typeof data.expires_at !== "string") throw new Error("Qoder PAT exchange returned invalid expiry");
    expiresAt = Date.parse(data.expires_at);
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= now + 300000) throw new Error("Qoder PAT exchange returned invalid expiry");

  return {
    jobToken: data.token,
    jobRefreshToken: typeof data.refresh_token === "string" ? data.refresh_token : "",
    expiresAt,
  };
}

/** Fetch user profile using a job token (jt-...). Best-effort. */
export async function fetchUserInfo(
  jobToken: string,
  mode: QoderMode,
  signal?: AbortSignal,
): Promise<{ userID: string; email: string; name: string }> {
  let userID = "";
  let email = "";
  let name = "";
  try {
    const res = await fetch(getQoderUserInfoURL(mode), {
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: "application/json",
        "User-Agent": UA,
        "Cosy-Version": QODER_OPENAPI_COSY_VERSION,
        "Cosy-ClientType": QODER_CLIENT_TYPE,
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const info = (await res.json()) as {
        id?: string;
        email?: string;
        name?: string;
        username?: string;
      };
      userID = typeof info?.id === "string" ? info.id : "";
      email = typeof info?.email === "string" ? info.email : "";
      name = typeof info?.name === "string" ? info.name : typeof info?.username === "string" ? info.username : "";
    }
  } catch {}
  return { userID, email, name };
}

/**
 * Build full Qoder credentials from a Personal Access Token.
 * Exchanges the PAT for a job token, resolves identity, and encodes the PAT
 * into the refresh field so the token can be re-exchanged on expiry.
 */
export async function credentialsFromPat(pat: string, mode: QoderMode, signal?: AbortSignal, knownUserID = ""): Promise<OAuthCredentials> {
  const region = getQoderRegionConfig(mode);
  const { jobToken, jobRefreshToken, expiresAt } = await exchangeJobToken(pat, mode, signal);
  const info = await fetchUserInfo(jobToken, mode, signal);
  const { email, name } = info;
  const userID = info.userID || knownUserID;
  if (signal?.aborted) throw new Error("Login cancelled");
  if (!userID) throw new Error("Qoder user identity is missing");
  const machineID = getMachineId();

  return {
    refresh: encodePatRefresh(pat, jobRefreshToken, userID, machineID),
    access: jobToken,
    expires: expiresAt - 5 * 60 * 1000, // 5 min buffer
    userID,
    email: email || region.userEmailFallback,
    name: name || region.userNameFallback,
    machineID,
  } as OAuthCredentials;
}
