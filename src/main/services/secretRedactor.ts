const SECRET_KEY_PATTERN =
  /api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|proxy-authorization|cookie|secret|password|credential|env/i;
const URL_SECRET_KEY_PATTERN = /key|token|secret|password|code|state|credential/i;
const MIN_SECRET_LENGTH = 4;

function stringVariants(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return [];
  const variants = new Set([trimmed]);
  try {
    variants.add(decodeURIComponent(trimmed));
  } catch {}
  try {
    variants.add(encodeURIComponent(trimmed));
  } catch {}
  return [...variants].filter((entry) => entry.length >= MIN_SECRET_LENGTH);
}

/** Main 侧值感知秘密集合；同一实例用于结果、receipt、事件与持久化投影。 */
export class SecretSet {
  private readonly values = new Set<string>();

  constructor(initial?: Iterable<string>) {
    if (initial) {
      for (const value of initial) this.add(value);
    }
  }

  add(value: unknown): void {
    if (typeof value !== 'string') return;
    for (const variant of stringVariants(value)) this.values.add(variant);
  }

  addFromUnknown(value: unknown, keyHint?: string, seen = new WeakSet<object>()): void {
    if (typeof value === 'string') {
      if (keyHint && SECRET_KEY_PATTERN.test(keyHint)) this.add(value);
      this.collectStringSecrets(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) this.addFromUnknown(entry, keyHint, seen);
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      this.addFromUnknown(entry, key, seen);
    }
  }

  redact<T>(value: T): T {
    return this.redactUnknown(value, new WeakSet<object>()) as T;
  }

  redactError(error: unknown): string {
    return this.redact(error instanceof Error ? error.message : String(error));
  }

  get size(): number {
    return this.values.size;
  }

  private collectStringSecrets(value: string): void {
    const authorization = value.match(/\b(?:bearer|basic)\s+([^\s,;]+)/gi) ?? [];
    for (const match of authorization) {
      this.add(match);
      this.add(match.replace(/^\w+\s+/u, ''));
    }
    try {
      const url = new URL(value);
      this.add(url.username);
      this.add(url.password);
      for (const [key, entry] of url.searchParams) {
        if (URL_SECRET_KEY_PATTERN.test(key)) this.add(entry);
      }
    } catch {}
  }

  private redactString(value: string): string {
    let result = value;
    const secrets = [...this.values].sort((left, right) => right.length - left.length);
    for (const secret of secrets) result = result.split(secret).join('[redacted]');
    return result.replace(
      /\b((?:bearer|basic)\s+|(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)=)([^\s,;&]+)/gi,
      '$1[redacted]'
    );
  }

  private redactUnknown(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return this.redactString(value);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[redacted-cycle]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((entry) => this.redactUnknown(entry, seen));
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? '[redacted]' : this.redactUnknown(entry, seen),
      ])
    );
  }
}

export function createSecretSet(...sources: unknown[]): SecretSet {
  const secrets = new SecretSet();
  for (const source of sources) {
    if (Array.isArray(source) && source.every((entry) => typeof entry === 'string')) {
      for (const value of source) secrets.add(value);
    } else {
      secrets.addFromUnknown(source);
    }
  }
  return secrets;
}
