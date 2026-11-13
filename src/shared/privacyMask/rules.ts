import type { MaskAction, PersonalKind, PrivacyMaskSettings } from './settings';

export type MaskCategory = 'secret' | 'personal' | 'custom';

export interface MaskSpan {
  start: number;
  end: number;
  kind: string;
  rule: string;
  action: MaskAction;
  category: MaskCategory;
  /** 可公开保留的前缀长度（preview / Shape 用） */
  keep: number;
}

interface Rule {
  kind: string | ((groups: string[]) => string);
  rule: string;
  re: RegExp;
  /** 取第几个捕获组作为值；0 为整段 */
  group?: number;
  keep?: RegExp | number;
  validate?: (value: string) => boolean;
}

interface CompiledRule extends Rule {
  action: MaskAction;
  category: MaskCategory;
}

export interface CompiledRules {
  active: boolean;
  rules: CompiledRule[];
  allow: Set<string>;
}

const B = '(?<![A-Za-z0-9_])';
const E = '(?![A-Za-z0-9_])';
const vendor = (rule: string, source: string, keep: RegExp): Rule => ({
  kind: 'API_KEY',
  rule,
  re: new RegExp(`${B}${source}${E}`, 'g'),
  keep,
});

const PLACEHOLDER_VALUE = /^\{\{[A-Z][A-Z_]*_[a-z2-7]{8}\}\}$/;
const SKIP_VALUE =
  /^(?:\$\{.*\}|\$[A-Za-z_]\w*|<[^>]*>|%[\w]+%|process\.env\..*|null|nil|none|true|false|undefined|x{3,}|\*{3,}|changeme|password|secret|your[_-].*)$/i;
const kvValue = (v: string) => v.length >= 6 && !SKIP_VALUE.test(v) && !PLACEHOLDER_VALUE.test(v);
const kvKind = ([key = '']: string[]) =>
  /pass|pwd|密码|口令/i.test(key) ? 'PASSWORD' : /token|令牌/i.test(key) ? 'TOKEN' : 'SECRET';

const SECRET_RULES: Rule[] = [
  {
    kind: 'PRIVATE_KEY',
    rule: 'pem',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    keep: 0,
  },
  vendor('openai', 'sk-[A-Za-z0-9_-]{16,}', /^sk-(?:ant-(?:api\d+-)?|proj-)?/),
  vendor('stripe', '[sr]k_(?:live|test)_[A-Za-z0-9]{10,}', /^[sr]k_(?:live|test)_/),
  vendor('github', 'gh[opusr]_[A-Za-z0-9]{20,}', /^gh[opusr]_/),
  vendor('github', 'github_pat_[A-Za-z0-9_]{20,}', /^github_pat_/),
  vendor('gitlab', 'glpat-[A-Za-z0-9_-]{20,}', /^glpat-/),
  vendor('google', 'AIza[0-9A-Za-z_-]{35}', /^AIza/),
  vendor('slack', 'xox[abprs]-[A-Za-z0-9-]{10,}', /^xox[abprs]-/),
  vendor('aws', '(?:AKIA|ASIA)[0-9A-Z]{16}', /^(?:AKIA|ASIA)/),
  vendor('huggingface', 'hf_[A-Za-z0-9]{20,}', /^hf_/),
  vendor('groq', 'gsk_[A-Za-z0-9]{20,}', /^gsk_/),
  vendor('xai', 'xai-[A-Za-z0-9]{20,}', /^xai-/),
  vendor('npm', 'npm_[A-Za-z0-9]{36}', /^npm_/),
  vendor('pypi', 'pypi-[A-Za-z0-9_-]{50,}', /^pypi-/),
  vendor('digitalocean', 'do[opr]_v1_[a-f0-9]{64}', /^do[opr]_v1_/),
  vendor('sendgrid', 'SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}', /^SG\./),
  {
    kind: 'TOKEN',
    rule: 'jwt',
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    keep: 3,
  },
  {
    kind: 'TOKEN',
    rule: 'bearer',
    re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/dg,
    group: 1,
    keep: 0,
  },
  {
    kind: 'PASSWORD',
    rule: 'url',
    // 先认 `:` 再回看 scheme：若从 scheme 起匹配，长串 `a.a.…` 的每个词首都会扫到串尾，二次复杂度
    re: /:(?<=\b[a-z][a-z0-9+.-]*:)\/\/[^\s/:@]+:([^\s/@]+)@/dgi,
    group: 1,
    keep: 0,
    validate: (v) => !SKIP_VALUE.test(v) && !PLACEHOLDER_VALUE.test(v),
  },
  {
    kind: kvKind,
    rule: 'kv',
    // 负回看跳过“更早的词首经 `xx_`/`xx-` 前缀能走到”的起点：这里能匹配的，那个词首必先匹配到；
    // 否则长串 `a-a-…` 的每个词首都要把前缀重扫到串尾，二次复杂度
    re: /\b(?<!(?:^|[^A-Za-z0-9_])(?:[A-Za-z0-9]+[_-])+?)(?:[A-Za-z0-9]+[_-])*(api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|passwd|password|pwd|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*(?:"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|([^\s"',;{}[\]]+))/dgi,
    group: -1,
    keep: 0,
    validate: kvValue,
  },
  {
    kind: kvKind,
    rule: 'cjk',
    re: /(密码|口令|密钥|秘钥|令牌)\s*(?:[:：=]|为|是)\s*([^\s，。、,;；"'“”‘’]{6,})/dg,
    group: 2,
    keep: 0,
    validate: kvValue,
  },
];

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
function validIdCard(v: string): boolean {
  const month = Number(v.slice(10, 12));
  const day = Number(v.slice(12, 14));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const sum = ID_WEIGHTS.reduce((acc, w, i) => acc + w * Number(v[i]), 0);
  return '10X98765432'[sum % 11] === v[17].toUpperCase();
}
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
const FAKE_EMAIL_DOMAIN =
  /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|local|localhost)$/i;

const PERSONAL_RULES: Record<PersonalKind, Rule> = {
  email: {
    kind: 'EMAIL',
    rule: 'email',
    re: /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g,
    keep: 0,
    validate: (v) => !/no-?reply/i.test(v) && !FAKE_EMAIL_DOMAIN.test(v.slice(v.indexOf('@') + 1)),
  },
  phone: {
    kind: 'PHONE',
    rule: 'cn-mobile',
    re: /(?<![\d+])(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g,
    keep: 0,
  },
  idCard: {
    kind: 'ID_CARD',
    rule: 'cn-id',
    re: /(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/g,
    keep: 0,
    validate: validIdCard,
  },
  bankCard: {
    kind: 'BANK_CARD',
    rule: 'luhn',
    re: /(?<![\d-])\d(?:[ -]?\d){14,18}(?!\d)/g,
    keep: 0,
    validate: (v) => {
      const digits = v.replace(/[ -]/g, '');
      return !/^(\d)\1+$/.test(digits) && luhn(digits);
    },
  },
  ip: {
    kind: 'IP',
    rule: 'ipv4',
    re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g,
    keep: 0,
    validate: (v) => !/^(?:127\.|0\.0\.0\.0$|255\.255\.255\.255$)/.test(v),
  },
};

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bounded = (s: string) =>
  `${/^\w/.test(s) ? B : ''}${escapeRegExp(s)}${/\w$/.test(s) ? E : ''}`;

function customRules(words: string[], rules: string[]): Rule[] {
  const out: Rule[] = words.map((w) => ({
    kind: 'CUSTOM',
    rule: 'word',
    re: new RegExp(bounded(w), 'gi'),
    keep: 0,
  }));
  for (const source of rules) {
    const literal = /^\/(.+)\/([a-z]*)$/s.exec(source);
    try {
      out.push(
        literal
          ? {
              kind: 'CUSTOM',
              rule: 'regex',
              re: new RegExp(literal[1], `${literal[2].replace(/[gyd]/g, '')}g`),
              keep: 0,
            }
          : {
              kind: 'CUSTOM',
              rule: 'prefix',
              re: new RegExp(
                `${/^\w/.test(source) ? B : ''}${escapeRegExp(source)}[A-Za-z0-9._-]+`,
                'g'
              ),
              keep: source.length,
            }
      );
    } catch {
      // 坏正则不阻断其它规则
    }
  }
  return out;
}

export function compileRules(settings: PrivacyMaskSettings): CompiledRules {
  const rules: CompiledRule[] = [];
  if (settings.enabled) {
    if (settings.secrets.enabled)
      for (const r of SECRET_RULES)
        rules.push({ ...r, action: settings.secrets.action, category: 'secret' });
    if (settings.personal.enabled)
      for (const k of settings.personal.kinds)
        rules.push({
          ...PERSONAL_RULES[k],
          action: settings.personal.action,
          category: 'personal',
        });
    for (const r of customRules(settings.custom.words, settings.custom.rules))
      rules.push({ ...r, action: settings.custom.action, category: 'custom' });
  }
  return {
    active: rules.length > 0,
    rules,
    allow: new Set(settings.allow.map((a) => a.toLowerCase())),
  };
}

const PLACEHOLDER_SCAN = /\{\{[A-Z][A-Z_]*_[a-z2-7]{8}\}\}/g;

function locate(rule: Rule, m: RegExpExecArray): [number, number] | undefined {
  const indices = m.indices;
  if (!rule.group) return [m.index, m.index + m[0].length];
  if (!indices) return undefined;
  if (rule.group > 0) return indices[rule.group];
  // -1：取首个命中的捕获组之后的值组（kv 的三种引号形态）
  for (let i = 2; i < indices.length; i++) if (indices[i]) return indices[i];
  return undefined;
}

export function findSpans(text: string, compiled: CompiledRules): MaskSpan[] {
  if (!compiled.active || !text) return [];
  const guarded: Array<[number, number]> = [];
  for (const m of text.matchAll(PLACEHOLDER_SCAN)) guarded.push([m.index, m.index + m[0].length]);
  const found: MaskSpan[] = [];
  for (const rule of compiled.rules) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(text); m; m = rule.re.exec(text)) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      const range = locate(rule, m);
      if (!range || range[1] <= range[0]) continue;
      const [start, end] = range;
      const value = text.slice(start, end);
      if (rule.validate && !rule.validate(value)) continue;
      if (compiled.allow.has(value.toLowerCase())) continue;
      if (guarded.some(([s, e]) => start < e && end > s)) continue;
      const keep =
        typeof rule.keep === 'number' ? rule.keep : (rule.keep?.exec(value)?.[0].length ?? 0);
      found.push({
        start,
        end,
        kind: typeof rule.kind === 'string' ? rule.kind : rule.kind([m[1] ?? '']),
        rule: rule.rule,
        action: rule.action,
        category: rule.category,
        keep: Math.min(keep, value.length),
      });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: MaskSpan[] = [];
  for (const span of found)
    if (!out.length || span.start >= out[out.length - 1].end) out.push(span);
  return out;
}
