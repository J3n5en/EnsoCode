export interface RedactSecretsOptions {
  mask?: string;
  /** true 保留 URL 中的用户名（user:MASK@）；false 连用户名与单段 token@ 一起脱敏 */
  preserveUrlUser?: boolean;
  /** 日志导出/展示额外脱敏本机用户路径、邮箱与手机号 */
  redactPii?: boolean;
}

const DEFAULT_MASK = '[REDACTED]';
const NON_SECRET_LITERALS = new Set(['true', 'false', 'null', 'undefined']);

const SECRET_NAME =
  '(?<![\\w-])[\\w-]*(?:key|token|secret|password|passwd|pwd|passphrase|authorization|auth|cookie|credentials?|signature)';

const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const URL_USER_PASS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi;
const URL_ANY_CRED = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const COOKIE_HEADER = /(\b(?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi;
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const PREFIX_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bgh[opusr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bxai-[A-Za-z0-9_-]{16,}/g,
  /\bgsk_[A-Za-z0-9_-]{16,}/g,
  /\bpplx-[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bpypi-[A-Za-z0-9_-]{20,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bya29\.[0-9A-Za-z._-]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  /(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g,
];

const ESCAPED_JSON_KV = new RegExp(
  `(${SECRET_NAME}\\\\"\\s*:\\s*\\\\")(?:[^"\\\\]|\\\\(?!"))*(\\\\")`,
  'gi'
);
const QUOTED_KV = new RegExp(
  `(${SECRET_NAME}["']?\\s*[:=]\\s*)(["'])(?:\\\\[\\s\\S]|(?!\\2)[^\\\\])*\\2`,
  'gi'
);
const BARE_KV = new RegExp(`(${SECRET_NAME}["']?\\s*[:=]\\s*)([^\\s"'&,;}{\\]]+)`, 'gi');

const POSIX_USER_DIR = /(^|[^\w])(\/(?:Users|home)\/)[^/\s"'`<>|]+(?=\/|\\|$|[\s"'`<>|])/g;
const WIN_USER_DIR_ESCAPED =
  /(^|[^\w])([A-Za-z]:\\\\Users\\\\)[^\\\s"'`<>|]+(?=\\\\|$|[\s"'`<>|])/gi;
const WIN_USER_DIR = /(^|[^\w])([A-Za-z]:\\Users\\)[^\\\s"'`<>|]+(?=\\|$|[\s"'`<>|])/gi;
const EMAIL_PATTERN = /(?<![\w/:-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CN_PHONE_PATTERN =
  /(?<![A-Za-z0-9_.-])(?:\+?86[\s-]?)?1[3-9]\d(?:[-\s]?\d{4}){2}(?![A-Za-z0-9_])/g;

export function redactSecrets(text: string, options: RedactSecretsOptions = {}): string {
  const mask = options.mask ?? DEFAULT_MASK;
  const preserveUrlUser = options.preserveUrlUser ?? true;
  let out = text;

  out = out.replace(PEM_PRIVATE_KEY, mask === DEFAULT_MASK ? mask : `${mask}PRIVATE KEY${mask}`);
  out = out.replace(preserveUrlUser ? URL_USER_PASS : URL_ANY_CRED, `$1${mask}@`);
  out = out.replace(COOKIE_HEADER, `$1${mask}`);
  out = out.replace(AUTH_SCHEME, `$1 ${mask}`);

  for (const pattern of PREFIX_PATTERNS) {
    out = out.replace(pattern, mask);
  }

  out = out.replace(ESCAPED_JSON_KV, `$1${mask}$2`);
  out = out.replace(QUOTED_KV, `$1$2${mask}$2`);
  out = out.replace(BARE_KV, (full, prefix: string, value: string, offset: number, src: string) => {
    if (
      value === mask ||
      src.startsWith(mask, offset + prefix.length) ||
      NON_SECRET_LITERALS.has(value.toLowerCase())
    ) {
      return full;
    }
    return `${prefix}${mask}`;
  });

  if (options.redactPii) {
    out = out.replace(POSIX_USER_DIR, '$1$2<user>');
    out = out.replace(WIN_USER_DIR_ESCAPED, '$1$2<user>');
    out = out.replace(WIN_USER_DIR, '$1$2<user>');
    out = out.replace(EMAIL_PATTERN, `${mask}@${mask}`);
    out = out.replace(CN_PHONE_PATTERN, mask);
  }

  return out;
}
