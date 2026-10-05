/** 最近一次模型请求的脱敏字节测量。payload 是序列化阶段，wire 是 fetch 前；均非 token 估计。 */
export interface RequestBodyUsage {
  bytes: number;
  limitBytes: number;
  stage: 'payload' | 'wire';
  blocked: boolean;
  at: number;
}

export function parseRequestBodyUsage(value: unknown): RequestBodyUsage | null {
  if (!isRecord(value)) return null;
  const keys = ['bytes', 'limitBytes', 'stage', 'blocked', 'at'];
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return null;
  if (
    typeof value.bytes !== 'number' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    typeof value.limitBytes !== 'number' ||
    !Number.isSafeInteger(value.limitBytes) ||
    value.limitBytes <= 0 ||
    typeof value.at !== 'number' ||
    !Number.isSafeInteger(value.at) ||
    value.at < 0 ||
    (value.stage !== 'payload' && value.stage !== 'wire') ||
    typeof value.blocked !== 'boolean' ||
    value.blocked !== value.bytes > value.limitBytes
  )
    return null;
  return {
    bytes: value.bytes,
    limitBytes: value.limitBytes,
    stage: value.stage,
    blocked: value.blocked,
    at: value.at,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
