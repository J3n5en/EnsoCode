import crypto from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { getMachineId } from "../cosy.js";
import {
  getQoderDeviceLoginURL,
  getQoderDevicePollURL,
  getQoderRegionConfig,
  getQoderUserInfoURL,
  type QoderMode,
} from "../region.js";
import { credentialsFromPat } from "./pat.js";

type PromptFn = (p: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;

function getPrompt(callbacks: OAuthLoginCallbacks): PromptFn {
  return (callbacks as unknown as { onPrompt: PromptFn }).onPrompt;
}

function getProgress(callbacks: OAuthLoginCallbacks): ((msg: string) => void) | undefined {
  return (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress;
}

function getSignal(callbacks: OAuthLoginCallbacks): AbortSignal | undefined {
  return (callbacks as unknown as { signal?: AbortSignal }).signal;
}

export function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function parseExpiresAt(s?: string, expiresInSeconds?: number): number {
  if (s) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return t;
    const ms = Number.parseInt(s, 10);
    if (!Number.isNaN(ms) && ms > 0) return ms;
  }
  if (expiresInSeconds && expiresInSeconds > 0) {
    return Date.now() + expiresInSeconds * 1000;
  }
  return Date.now() + 30 * 24 * 60 * 60 * 1000; // default 30 days
}

export async function interactiveLogin(callbacks: OAuthLoginCallbacks, mode: QoderMode): Promise<OAuthCredentials> {
  const region = getQoderRegionConfig(mode);
  // pi drives this via its built-in LoginDialog, which wires onPrompt/onAuth/
  // onProgress to a focused input. We must use those callbacks directly rather
  // than opening our own ctx.ui.custom surface (which would steal focus and
  // leave onPrompt unable to receive keystrokes).
  const prompt = getPrompt(callbacks);
  const pat = await prompt({
    message: !region.supportsBrowserLogin
      ? "Paste a Qoder CN Personal Access Token, or leave empty to cancel"
      : "Paste a Qoder Personal Access Token (pt-...), or leave empty for browser login",
    placeholder: "pt-...",
    allowEmpty: true,
  });
  if (getSignal(callbacks)?.aborted) throw new Error("Login cancelled");
  if (pat?.trim()) {
    return patLogin(callbacks, pat.trim(), mode);
  }

  if (!region.supportsBrowserLogin) {
    throw new Error(
      `Qoder CN browser login is not supported here. Paste a Qoder CN PAT from ${region.patManageUrl} or set QODERCN_PERSONAL_ACCESS_TOKEN.`,
    );
  }

  if (getSignal(callbacks)?.aborted) throw new Error("Login cancelled");
  return runDeviceFlow(callbacks);
}

/** Prompt for a PAT (if not provided) and exchange it for full credentials. */
async function patLogin(
  callbacks: OAuthLoginCallbacks,
  providedPat: string | undefined,
  mode: QoderMode,
): Promise<OAuthCredentials> {
  const region = getQoderRegionConfig(mode);
  let pat = providedPat;
  if (!pat) {
    const prompt = getPrompt(callbacks);
    const entered = await prompt({
      message: !region.supportsBrowserLogin
        ? "Paste your Qoder CN Personal Access Token"
        : "Paste your Qoder Personal Access Token (pt-...)",
      placeholder: "pt-...",
      allowEmpty: false,
    });
    if (getSignal(callbacks)?.aborted) throw new Error("Login cancelled");
    pat = entered?.trim();
  }
  if (!pat) {
    throw new Error("No Personal Access Token provided");
  }
  getProgress(callbacks)?.("Exchanging access token...");
  const creds = await credentialsFromPat(pat, mode, getSignal(callbacks));
  getProgress(callbacks)?.("Login successful!");
  return creds;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("Login cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new Error("Login cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runDeviceFlow(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const nonce = crypto.randomUUID();
  const machineID = getMachineId();

  const verificationURI = getQoderDeviceLoginURL(codeChallenge, machineID, nonce);

  getProgress(callbacks)?.("Please complete login in your browser...");

  (callbacks as unknown as { onAuth: (info: { url: string; instructions: string }) => void }).onAuth({
    url: verificationURI,
    instructions: "Click to sign in with your Qoder account in the browser.",
  });

  const pollURL = getQoderDevicePollURL(nonce, codeVerifier);
  const pollInterval = 2000;
  const maxAttempts = 90; // 3 minutes

  let networkFailed = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (getSignal(callbacks)?.aborted) throw new Error("Login cancelled");
    await abortableDelay(pollInterval, getSignal(callbacks));
    networkFailed = false;

    try {
      const response = await fetch(pollURL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "pi-provider-qoder",
        },
        signal: getSignal(callbacks) ? AbortSignal.any([getSignal(callbacks)!, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      });

      if (response.status === 202 || response.status === 404) {
        // Pending
        continue;
      }

      if (!response.ok) {
        throw new Error(`Device token poll failed: ${response.status}`);
      }

      let tokenData: {
        token: string;
        user_id: string;
        refresh_token: string;
        expires_at?: string;
        expires_in?: number;
      };
      try { tokenData = await response.json() as typeof tokenData; } catch { throw new Error("Device token poll returned invalid response"); }

      if (typeof tokenData?.token !== "string" || !tokenData.token || typeof tokenData.user_id !== "string" || !tokenData.user_id || typeof tokenData.refresh_token !== "string" || !tokenData.refresh_token) {
        throw new Error("Device token poll returned empty access token");
      }

      const expireMs = parseExpiresAt(tokenData.expires_at, tokenData.expires_in);

      // Fetch user info (best effort)
      getProgress(callbacks)?.("Fetching user profile...");
      let email = "";
      let name = "";
      try {
        const userinfoRes = await fetch(getQoderUserInfoURL("global"), {
          method: "GET",
          headers: {
            Authorization: `Bearer ${tokenData.token}`,
            Accept: "application/json",
            "User-Agent": "pi-provider-qoder",
          },
          signal: getSignal(callbacks) ? AbortSignal.any([getSignal(callbacks)!, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
        });
        if (userinfoRes.ok) {
          const userinfo = (await userinfoRes.json()) as {
            email?: string;
            name?: string;
            username?: string;
          };
          email = userinfo.email || "";
          name = userinfo.name || userinfo.username || "";
        }
      } catch {}
      if (getSignal(callbacks)?.aborted) throw new Error("Login cancelled");

      getProgress(callbacks)?.("Login successful!");

      return {
        refresh: `${tokenData.refresh_token}|${tokenData.user_id}|${machineID}`,
        access: tokenData.token,
        expires: expireMs - 5 * 60 * 1000, // 5 min buffer
        userID: tokenData.user_id,
        email,
        name,
        machineID,
      } as OAuthCredentials;
    } catch (e: unknown) {
      const err = e as { name?: string };
      if (err.name === "AbortError" || getSignal(callbacks)?.aborted) {
        throw new Error("Login cancelled");
      }
      if (e instanceof Error && e.message.startsWith("Device token poll")) throw e;
      // A single poll timing out or a transient network failure must not end the whole login window.
      networkFailed = true;
      continue;
    }
  }

  if (networkFailed) throw new Error("Qoder device login network error");
  throw new Error("Authorization timed out");
}
