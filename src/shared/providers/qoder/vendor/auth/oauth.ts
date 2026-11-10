import type { OAuthCredentials } from '@earendil-works/pi-ai';
import { getMachineId } from '../cosy.js';
import { getQoderRefreshURL, getQoderRegionConfig, type QoderMode } from '../region.js';
import { credentialsFromPat, decodePatRefresh, fetchUserInfo, isPatRefresh } from './pat.js';

export interface QoderIdentity extends OAuthCredentials {
  userID: string;
  machineID: string;
  name: string;
  email: string;
}

const prefix = 'enso-qoder:';
const identities = new Map<string, QoderIdentity>();

export function encodeQoderKey(credentials: OAuthCredentials, mode: QoderMode): string {
  return prefix + Buffer.from(JSON.stringify({ mode, access: credentials.access, userID: credentials.userID, machineID: credentials.machineID, name: credentials.name, email: credentials.email })).toString('base64url');
}

export async function resolveQoderIdentity(key: string, providerID: string, mode: QoderMode, signal?: AbortSignal): Promise<QoderIdentity> {
  let access = key;
  if (key.startsWith(prefix)) {
    let value: unknown;
    try { value = JSON.parse(Buffer.from(key.slice(prefix.length), 'base64url').toString('utf8')); } catch { throw new Error('Invalid Qoder credentials'); }
    if (!value || typeof value !== 'object') throw new Error('Invalid Qoder credentials');
    const data = value as Record<string, unknown>;
    if (data.mode !== mode || typeof data.access !== 'string' || !data.access) throw new Error('Invalid Qoder credentials');
    access = data.access;
    if (typeof data.userID === 'string' && data.userID && typeof data.machineID === 'string' && data.machineID) {
      return { access, refresh: '', expires: 0, userID: data.userID, machineID: data.machineID, name: typeof data.name === 'string' ? data.name : '', email: typeof data.email === 'string' ? data.email : '' };
    }
  }
  const cacheKey = `${providerID}:${access}`;
  const cached = identities.get(cacheKey);
  if (cached) return cached;
  const info = await fetchUserInfo(access, mode, signal);
  if (signal?.aborted) throw new Error('Qoder request cancelled');
  if (!info.userID) throw new Error('Qoder user identity is missing');
  const region = getQoderRegionConfig(mode);
  const result = { access, refresh: '', expires: 0, userID: info.userID, machineID: getMachineId(), name: info.name || region.userNameFallback, email: info.email || region.userEmailFallback };
  identities.set(cacheKey, result);
  return result;
}

export async function refreshQoderToken(credentials: OAuthCredentials, mode: QoderMode, signal?: AbortSignal): Promise<OAuthCredentials> {
  if (isPatRefresh(credentials.refresh)) {
    const { pat, userID } = decodePatRefresh(credentials.refresh);
    if (!pat) throw new Error('Qoder PAT is missing');
    return credentialsFromPat(pat, mode, signal, userID);
  }
  const [refreshToken, userID, machineID] = credentials.refresh.split('|');
  if (!refreshToken || !userID || !machineID) throw new Error('Qoder refresh credentials are invalid');
  let response: Response;
  try { response = await fetch(getQoderRefreshURL(mode), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.access}`, Accept: 'application/json' },
    body: JSON.stringify({ refreshToken }), redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  }); } catch {
    if (signal?.aborted) throw new Error('Qoder refresh cancelled');
    throw new Error('Qoder refresh network error');
  }
  if (!response.ok) throw new Error(`Qoder refresh failed: ${response.status}`);
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error('Qoder refresh returned invalid response'); }
  if (!data || typeof data !== 'object') throw new Error('Qoder refresh returned invalid response');
  const value = data as Record<string, unknown>;
  if (typeof value.token !== 'string' || !value.token) throw new Error('Qoder refresh returned empty token');
  const expiry = typeof value.expires_at === 'string' ? Date.parse(value.expires_at) : typeof value.expires_in === 'number' ? Date.now() + value.expires_in * 1000 : NaN;
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Qoder refresh returned invalid expiry');
  return { ...credentials, access: value.token, refresh: `${typeof value.refresh_token === 'string' && value.refresh_token ? value.refresh_token : refreshToken}|${userID}|${machineID}`, expires: expiry - 300000, userID, machineID };
}
