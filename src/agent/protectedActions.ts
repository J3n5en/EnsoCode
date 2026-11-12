import os from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApprovalKind, ProtectedActionCategory } from '@shared/types/agent';
import { globToRegExp } from './globMatch';

/**
 * 受保护动作底线的规则分类器：对外发送 / 删除 / 付款 / 部署改生产 / 读取或外传密钥。
 * 只做规则匹配，宁可多问不可漏问；命中后由 ApprovalGate 无视审批档位强制要求真人确认。
 */

const SECRET_BASENAMES =
  /^(\.env(\.(?!(example|sample|template|dist|defaults)$)[\w.-]+)?|id_(rsa|dsa|ecdsa|ed25519)|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|credentials\.json|oauth-accounts\.json|secrets?\.(json|ya?ml|env)|[\w.-]+\.(pem|key|p12|pfx|keystore|jks))$/i;
const SECRET_PATH_SUFFIX =
  /(^|\/)(\.aws\/credentials|\.docker\/config\.json|\.kube\/config|pi-agent\/auth\.json)$/i;

export function isSecretFilePath(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return false;
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return SECRET_BASENAMES.test(base) || SECRET_PATH_SUFFIX.test(normalized);
}

/** 家目录下的凭据目录。只认家目录下的：仓库里的 .docker/、.kube/ 是普通配置；pi-agent/auth.json 由文件规则覆盖。 */
const SECRET_HOME_DIRS = ['.ssh', '.aws', '.docker', '.kube', '.gnupg'];

export function isUnderSecretDirectory(expanded: string): boolean {
  const fold = (value: string) => {
    const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'linux' ? normalized : normalized.toLowerCase();
  };
  const target = fold(expanded);
  const home = fold(os.homedir());
  if (!target || !home) return false;
  return SECRET_HOME_DIRS.some((dir) => {
    const root = `${home}/${dir}`;
    return target === root || target.startsWith(`${root}/`);
  });
}

/**
 * isSecretFilePath 能认出的代表名。通配 glob 用它们判断「必然或主要指向密钥」，
 * 而不是把任何能套到 credentials.json 的宽模式都拦下来。
 */
const SECRET_GLOB_PROBES = [
  '.env',
  '.env.local',
  'id_rsa',
  'id_ed25519',
  'a.pem',
  'a.key',
  'cert.p12',
  'credentials.json',
  'oauth-accounts.json',
  'secrets.json',
  'secret.yaml',
  '.npmrc',
  '.netrc',
  '.ssh/id_rsa',
  '.aws/credentials',
  '.docker/config.json',
  '.kube/config',
  'pi-agent/auth.json',
];
/** 普通文件。命中任一则说明该 glob 太宽（`*`、`*.json`、`a.*`）。 */
const UNRELATED_GLOB_PROBES = [
  'src/app.ts',
  'src/App.tsx',
  'README.md',
  'package.json',
  'tsconfig.json',
  'src/config.json',
  'notes.txt',
  'a.ts',
  'a.json',
  'a.md',
  'a.txt',
  'x',
];

function topLevelBrace(pattern: string): number {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close !== -1) {
        i = close;
        continue;
      }
    }
    if (pattern[i] === '{') return i;
  }
  return -1;
}

function matchBrace(pattern: string, start: number): number {
  let depth = 0;
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close !== -1) {
        i = close;
        continue;
      }
    }
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let brace = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '[') {
      const close = body.indexOf(']', i + 1);
      if (close !== -1) {
        current += body.slice(i, close + 1);
        i = close;
        continue;
      }
    }
    if (ch === '{') brace++;
    if (ch === '}' && brace > 0) brace--;
    if (ch === ',' && brace === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** 花括号候选上限；超出时按指向密钥处理，避免组合爆炸卡住 worker。 */
const MAX_BRACE_ALTERNATIVES = 256;

class BraceLimitError extends Error {}

/** ripgrep `{a,b}`；单项 `{.env}` 在 rg 里同样是选择，等同 `.env`。 */
function expandBraceAlternatives(pattern: string): string[] {
  const start = topLevelBrace(pattern);
  if (start < 0) return [pattern];
  const end = matchBrace(pattern, start);
  if (end < 0) return [pattern];
  const parts = splitTopLevelCommas(pattern.slice(start + 1, end));
  const prefix = pattern.slice(0, start);
  const suffix = pattern.slice(end + 1);
  const tails = expandBraceAlternatives(suffix);
  if (parts.length * tails.length > MAX_BRACE_ALTERNATIVES) throw new BraceLimitError();
  const out: string[] = [];
  for (const part of parts) {
    for (const tail of tails) {
      out.push(...expandBraceAlternatives(prefix + part + tail));
      if (out.length > MAX_BRACE_ALTERNATIVES) throw new BraceLimitError();
    }
  }
  return out;
}

function alternativeTargetsSecrets(pattern: string): boolean {
  let matched: (probe: string) => boolean;
  try {
    const re = new RegExp(globToRegExp(pattern, { classes: true }).source, 'i');
    matched = (probe) => re.test(probe);
  } catch {
    return true;
  }
  if (!SECRET_GLOB_PROBES.some(matched)) return false;
  return !UNRELATED_GLOB_PROBES.some(matched);
}

/**
 * 无通配符仍按文件名规则。有 `*?[]{}` 时：任一花括号候选命中密钥探针、且不命中无关文件，才算主要指向密钥。
 * `.env.example` 这类近失不在无关探针里，因此 `.env*` 仍拦；`*.json` / `*` 会套到普通文件，不拦。
 */
function globTargetsSecrets(glob: string): boolean {
  const trimmed = glob.trim();
  if (!trimmed || trimmed.startsWith('!')) return false;
  if (!/[*?[\]{}]/.test(trimmed)) return isSecretFilePath(trimmed);
  let alternatives: string[];
  try {
    alternatives = expandBraceAlternatives(trimmed);
  } catch (error) {
    if (error instanceof BraceLimitError) return true;
    throw error;
  }
  return alternatives.some(
    (alt) => alt.length > 0 && !alt.startsWith('!') && alternativeTargetsSecrets(alt)
  );
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * 按 pi 内置文件工具（read/grep/edit/write 的 resolveToCwd）的规则展开路径，不拼 cwd：
 * Unicode 空格转半角、去一个前导 @、Windows 下转换 Git Bash 盘符路径、展开 ~、file:// 转本地路径。
 * 安全判定必须和工具真实访问的路径同源，否则 @.env、~/x 这类写法按字面判定会被绕过；
 * pi 包入口没导出这组函数，只能对照 pi-coding-agent 的 dist/utils/paths.js 复刻，升级 pi 时要一起核对。
 */
export function expandPiToolPath(
  input: string,
  platform: NodeJS.Platform = process.platform
): string {
  const win = platform === 'win32';
  let normalized = input.replace(UNICODE_SPACES, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (win) normalized = windowsShellPath(normalized);
  const home = os.homedir();
  if (normalized === '~') return home;
  if (normalized.startsWith('~/') || (win && normalized.startsWith('~\\')))
    return (win ? nodePath.win32 : nodePath.posix).join(home, normalized.slice(2));
  if (/^file:\/\//.test(normalized)) {
    try {
      return fileURLToPath(normalized);
    } catch {
      // 非法 file URL 在 pi 里同样抛错、不会访问文件，保留原文即可
      return normalized;
    }
  }
  return normalized;
}

/** pi 的 normalizeWindowsShellPath：/c/x、/mnt/c/x、/cygdrive/c/x → C:\x */
function windowsShellPath(filePath: string): string {
  if (!filePath.startsWith('/') || filePath.startsWith('//') || filePath.includes('\\'))
    return filePath;
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(filePath);
  if (!match) return filePath;
  return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll('/', '\\') ?? ''}`;
}

const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'nohup',
  'time',
  'command',
  'exec',
  'nice',
  'xargs',
]);
/**
 * 包装程序里要带值的选项（短选项字母 / 长选项名）：值可粘连（-n10、--user=x）也可是下一个 token。
 * 不跳过值会把 sudo -u postgres 的 postgres、nice -n 10 的 10 当成程序名，后面的危险命令整段漏判。
 * env -S 故意不列：它的值本身就是命令行，按空白切开后紧跟的正是程序名。
 */
const WRAPPER_VALUE_OPTIONS: Record<string, { short: string; long: readonly string[] }> = {
  sudo: {
    short: 'CDgpRrTtUu',
    long: [
      'chdir',
      'chroot',
      'close-from',
      'command-timeout',
      'group',
      'host',
      'other-user',
      'prompt',
      'role',
      'type',
      'user',
    ],
  },
  doas: { short: 'aCu', long: [] },
  env: { short: 'aCLPUu', long: ['argv0', 'chdir', 'unset'] },
  nice: { short: 'n', long: ['adjustment'] },
  time: { short: 'fo', long: ['format', 'output'] },
  exec: { short: 'a', long: [] },
  xargs: {
    short: 'adEIJLnPRSs',
    long: ['arg-file', 'delimiter', 'max-args', 'max-chars', 'max-procs', 'process-slot-var'],
  },
  timeout: { short: 'ks', long: ['kill-after', 'signal'] },
};
/** shell 保留字之后才是真正执行的命令（then rm -rf x、! git push -f）；{ ( 已由 unquote 清空 */
const RESERVED_WORDS = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish']);
const SCRIPT_RUNNERS = new Set([
  'node',
  'python',
  'python3',
  'ruby',
  'perl',
  'tsx',
  'ts-node',
  'deno',
  'bun',
]);
const DB_CLIENTS = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'duckdb',
  'mongo',
  'mongosh',
  'sqlcmd',
  'clickhouse-client',
  'cockroach',
  'redis-cli',
]);
const MAIL_PROGRAMS = new Set(['mail', 'mailx', 'sendmail', 'mutt', 'swaks', 'msmtp']);
const DEPLOY_CLIS = new Set([
  'gcloud',
  'az',
  'aws',
  'heroku',
  'fly',
  'flyctl',
  'netlify',
  'firebase',
  'wrangler',
  'serverless',
  'sls',
  'cdk',
  'eb',
  'railway',
  'doctl',
]);
const DEPLOY_WORD = /^(deploy|deployment|publish|release|promote|rollout|prod|production)$/i;
const LOCAL_HOST = /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[?::1\]?|[\w.-]+\.localhost)$/i;
const REGISTRY_HOST =
  /(^|\.)(registry\.npmjs\.org|registry\.yarnpkg\.com|registry\.npmmirror\.com|pypi\.org|files\.pythonhosted\.org|crates\.io|rubygems\.org|repo\.maven\.apache\.org|proxy\.golang\.org)$/i;
const PAYMENT_HOST =
  /(^|\.)(stripe\.com|paypal\.com|braintreegateway\.com|adyen\.com|squareup\.com|alipay\.com|mch\.weixin\.qq\.com)$/i;

function words(text: string): string[] {
  return text.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
}

function hasDeployWord(text: string): boolean {
  return words(text).some((w) => DEPLOY_WORD.test(w));
}

function unquote(token: string): string {
  return token.replace(/^[({'"]+|[)}'";]+$/g, '');
}

/** 跳过包装程序自己的选项及其值，返回第一个非选项 token 的下标 */
function skipWrapperOptions(tokens: string[], start: number, wrapper: string): number {
  const spec = WRAPPER_VALUE_OPTIONS[wrapper];
  let i = start;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const token = tokens[i++];
    if (token === '--') break;
    if (!spec) continue;
    if (token.startsWith('--')) {
      if (!token.includes('=') && spec.long.includes(token.slice(2))) i++;
      continue;
    }
    // 短选项可合并（-iu postgres）：首个带值字母之后的部分就是它的值，位于末尾时值是下一个 token
    const letters = token.slice(1);
    const at = [...letters].findIndex((letter) => spec.short.includes(letter));
    if (at !== -1 && at === letters.length - 1) i++;
  }
  return i;
}

/** 把一段命令拆成去引号的 token，并剥掉 shell 保留字、env 赋值与 sudo/xargs 之类的包装程序 */
export function programTokens(segment: string): string[] {
  // 被 unquote 清空的 token（{}、""）先占位，选项值才能和原命令行对齐（xargs -I {} rm …）
  const tokens = segment.trim().split(/\s+/).map(unquote);
  let i = 0;
  for (;;) {
    while (
      i < tokens.length &&
      (!tokens[i] || RESERVED_WORDS.has(tokens[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))
    )
      i++;
    const head = basename(tokens[i] ?? '');
    if (WRAPPERS.has(head)) {
      i = skipWrapperOptions(tokens, i + 1, head);
      continue;
    }
    if (head === 'timeout') {
      i = skipWrapperOptions(tokens, i + 1, head);
      // 选项之后是时长参数，再之后才是被包装的命令
      if (/^\d/.test(tokens[i] ?? '')) i++;
      continue;
    }
    return tokens.slice(i).filter(Boolean);
  }
}

function basename(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1);
}

function hostOf(url: string): string | null {
  const match = /^(?:[a-z][\w+.-]*:\/\/)?(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/\s?#]+)/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

/** 非本机、非包管理源的目标；无法确定目标时按外部处理 */
function remoteTargetCategory(urls: string[]): ProtectedActionCategory | null {
  if (urls.length === 0) return 'external-send';
  let category: ProtectedActionCategory | null = null;
  for (const url of urls) {
    const host = hostOf(url);
    if (!host) return 'external-send';
    if (PAYMENT_HOST.test(host)) return 'payment';
    if (!LOCAL_HOST.test(host) && !REGISTRY_HOST.test(host)) category = 'external-send';
  }
  return category;
}

function urlArgs(args: string[]): string[] {
  return args.filter((t) => /^[a-z][\w+.-]*:\/\//i.test(t));
}

function classifyCurl(args: string[]): ProtectedActionCategory | null {
  const urls = urlArgs(args);
  if (urls.some((u) => PAYMENT_HOST.test(hostOf(u) ?? ''))) return 'payment';
  const sends = args.some(
    (t, i) =>
      /^(-d|--data.*|-F|--form.*|--json|-T|--upload-file)$/.test(t) ||
      /^(-d|-F|-T)\S/.test(t) ||
      /^--(data|form|json)/.test(t) ||
      ((t === '-X' || t === '--request') && /^(POST|PUT|PATCH|DELETE)$/i.test(args[i + 1] ?? '')) ||
      /^(-X|--request=)(POST|PUT|PATCH|DELETE)$/i.test(t)
  );
  return sends ? remoteTargetCategory(urls) : null;
}

function classifyGit(args: string[]): ProtectedActionCategory | null {
  let i = 0;
  while (i < args.length && args[i].startsWith('-'))
    i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  const shortHas = (letters: RegExp) => rest.some((t) => /^-[A-Za-z]+$/.test(t) && letters.test(t));
  switch (sub) {
    case 'push':
      return shortHas(/[fd]/) ||
        rest.some((t) =>
          /^--(force|force-with-lease|force-if-includes|delete|mirror|prune)(=|$)/.test(t)
        ) ||
        rest.some((t) => /^[+:]/.test(t))
        ? 'delete'
        : null;
    case 'branch':
    case 'tag':
      return shortHas(/[dD]/) || rest.includes('--delete') ? 'delete' : null;
    case 'reset':
      return rest.includes('--hard') ? 'delete' : null;
    case 'clean':
      return shortHas(/f/) || rest.includes('--force') ? 'delete' : null;
    default:
      return null;
  }
}

const KUBE_DELETE = new Set(['delete']);
const KUBE_MUTATE = new Set([
  'apply',
  'create',
  'replace',
  'patch',
  'edit',
  'scale',
  'rollout',
  'set',
  'annotate',
  'label',
  'drain',
  'cordon',
  'taint',
  'autoscale',
  'expose',
  'run',
]);

function firstPositional(args: string[]): string | undefined {
  return args.find((t) => !t.startsWith('-'));
}

function classifySegment(segment: string, depth: number): ProtectedActionCategory | null {
  const tokens = programTokens(segment);
  if (tokens.length === 0) return null;
  const program = basename(tokens[0]);
  const args = tokens.slice(1);
  const sub = firstPositional(args);

  if (SHELLS.has(program)) {
    const c = args.indexOf('-c');
    if (c !== -1 && depth < 3) return classifyCommandText(args.slice(c + 1).join(' '), depth + 1);
    return sub && hasDeployWord(basename(sub)) ? 'deploy' : null;
  }
  if (tokens[0].includes('/') && hasDeployWord(program)) return 'deploy';

  switch (program) {
    case 'rm':
      return args.some((t) => /^-[A-Za-z]*[rR]/.test(t) || t === '--recursive') ? 'delete' : null;
    case 'find':
      return args.includes('-delete') ||
        args.some(
          (t, i) =>
            (t === '-exec' || t === '-execdir') &&
            /^(rm|shred|unlink)$/.test(basename(args[i + 1] ?? ''))
        )
        ? 'delete'
        : null;
    case 'shred':
    case 'wipefs':
      return 'delete';
    case 'dd':
      return args.some((t) => t.startsWith('of=/dev/')) ? 'delete' : null;
    case 'git':
      return classifyGit(args);
    case 'kubectl':
    case 'oc':
      if (sub && KUBE_DELETE.has(sub)) return 'delete';
      return sub && KUBE_MUTATE.has(sub) ? 'deploy' : null;
    case 'helm':
      if (sub === 'uninstall' || sub === 'delete') return 'delete';
      return sub === 'install' || sub === 'upgrade' || sub === 'rollback' ? 'deploy' : null;
    case 'terraform':
    case 'tofu':
    case 'pulumi':
      if (sub === 'destroy') return 'delete';
      return sub === 'apply' || sub === 'import' || sub === 'up' || sub === 'update'
        ? 'deploy'
        : null;
    case 'docker':
    case 'podman':
      if (sub === 'push') return 'deploy';
      return args.includes('prune') || (sub === 'volume' && args.includes('rm')) ? 'delete' : null;
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      if (!sub) return null;
      if (sub === 'publish' || sub === 'unpublish' || sub === 'deprecate' || sub === 'deploy')
        return 'deploy';
      if (sub === 'npm' && args.includes('publish')) return 'deploy';
      const script =
        sub === 'run' || sub === 'run-script'
          ? firstPositional(args.slice(args.indexOf(sub) + 1))
          : sub;
      return script && hasDeployWord(script) ? 'deploy' : null;
    }
    case 'cargo':
    case 'poetry':
    case 'flit':
    case 'gradle':
    case './gradlew':
      return sub === 'publish' ? 'deploy' : null;
    case 'twine':
      return sub === 'upload' ? 'deploy' : null;
    case 'gem':
      return sub === 'push' ? 'deploy' : null;
    case 'mvn':
      return args.includes('deploy') ? 'deploy' : null;
    case 'make':
    case 'just':
    case 'task':
    case 'rake':
      return args.some((t) => !t.startsWith('-') && !t.includes('=') && hasDeployWord(t))
        ? 'deploy'
        : null;
    case 'vercel':
      return sub &&
        /^(dev|login|logout|whoami|ls|list|inspect|logs|pull|link|help|env|build)$/.test(sub)
        ? null
        : 'deploy';
    case 'gh':
      if (sub === 'release' && args.includes('create')) return 'deploy';
      if (sub === 'repo' && args.includes('delete')) return 'delete';
      if (
        (sub === 'pr' || sub === 'issue') &&
        args.some((t) => /^(create|comment|review|close|merge|edit)$/.test(t))
      )
        return 'external-send';
      return sub === 'api' &&
        args.some((t) => /^(-X|--method|-f|-F|--field|--raw-field|--input)$/.test(t))
        ? 'external-send'
        : null;
    case 'stripe':
      return args.some((t) => /^(create|update|delete|pay|capture|confirm|refund|post)$/.test(t))
        ? 'payment'
        : null;
    case 'curl':
      return classifyCurl(args);
    case 'wget':
      return args.some((t) => /^--(post-data|post-file|body-data|body-file|method)/.test(t))
        ? remoteTargetCategory(urlArgs(args))
        : null;
    case 'http':
    case 'https':
    case 'xh':
      return args.some((t) => /^(POST|PUT|PATCH|DELETE)$/.test(t))
        ? remoteTargetCategory(
            urlArgs(args).length ? urlArgs(args) : args.filter((t) => /\./.test(t)).slice(0, 1)
          )
        : null;
    case 'scp':
    case 'rsync':
    case 'sftp':
    case 'ftp': {
      const remote = args.filter((t) => !t.startsWith('-') && /^([\w.-]+@)?[\w.-]+:/.test(t));
      return remote.length ? remoteTargetCategory(remote.map((t) => t.replace(/:.*$/, ''))) : null;
    }
    case 'nc':
    case 'ncat':
    case 'netcat':
    case 'socat':
      if (args.some((t) => /^-[A-Za-z]*[lz]/.test(t))) return null;
      return remoteTargetCategory(
        args.filter((t) => !t.startsWith('-') && !/^\d+$/.test(t)).slice(0, 1)
      );
    case 'security':
      return sub &&
        /^(find-generic-password|find-internet-password|dump-keychain|export)$/.test(sub)
        ? 'secret'
        : null;
    case 'gpg':
      return args.some((t) => /^--export-secret/.test(t)) ? 'secret' : null;
  }
  if (MAIL_PROGRAMS.has(program)) return 'external-send';
  if (DEPLOY_CLIS.has(program)) {
    const flat = args.flatMap((t) => t.split(/[:/]/));
    if (flat.some((t) => /^(delete|destroy|rm|rb|remove)$/.test(t))) return 'delete';
    if (flat.some((t) => /^(deploy|publish|release|promote|up)$/.test(t))) return 'deploy';
    if (
      program === 'aws' &&
      sub === 's3' &&
      /^(cp|sync|mv)$/.test(args[1] ?? '') &&
      args.some((t) => t.startsWith('s3://'))
    )
      return 'external-send';
    return null;
  }
  if (SCRIPT_RUNNERS.has(program) && sub && !sub.startsWith('-') && hasDeployWord(basename(sub)))
    return 'deploy';
  return null;
}

const SQL_DESTRUCTIVE =
  /\b(drop\s+(table|database|schema|collection|index|view)|truncate\s+(table\s+)?\w|delete\s+from|flushall|flushdb|dropDatabase\s*\()/i;
const INLINE_HTTP_SEND =
  /\b(requests|httpx|axios|urllib3?|aiohttp|session)\s*\.\s*(post|put|patch|delete)\s*\(|method\s*[:=]\s*['"](POST|PUT|PATCH|DELETE)['"]|\bsmtplib\b|\bnodemailer\b/i;

function secretInText(text: string): boolean {
  return text
    .split(/[\s|;&<>()`]+/)
    .map(unquote)
    .filter(Boolean)
    .some((token) => {
      const candidates = [
        token,
        token.slice(token.lastIndexOf('=') + 1),
        token.slice(token.lastIndexOf('@') + 1),
      ];
      return candidates.some((c) => c && isSecretFilePath(c));
    });
}

function classifyCommandText(command: string, depth: number): ProtectedActionCategory | null {
  if (secretInText(command)) return 'secret';
  const segments = command.split(/\|\|?|&&?|;|\n|\$\(|`|\)/);
  const programs = segments.map((s) => basename(programTokens(s)[0] ?? ''));
  if (programs.some((p) => DB_CLIENTS.has(p)) && SQL_DESTRUCTIVE.test(command)) return 'delete';
  const found = segments.map((s) => classifySegment(s, depth)).filter((c) => c !== null);
  for (const category of ['payment', 'deploy', 'delete', 'external-send', 'secret'] as const) {
    if (found.includes(category)) return category;
  }
  if (programs.some((p) => SCRIPT_RUNNERS.has(p)) && INLINE_HTTP_SEND.test(command)) {
    const urls = command.match(/[a-z][\w+.-]*:\/\/[^\s'"`)]+/gi) ?? [];
    return remoteTargetCategory(urls);
  }
  return null;
}

export function classifyProtectedCommand(command: string): ProtectedActionCategory | null {
  return classifyCommandText(command, 0);
}

const READ_VERBS = new Set([
  'get',
  'list',
  'search',
  'read',
  'fetch',
  'query',
  'describe',
  'view',
  'show',
  'find',
  'lookup',
  'count',
  'check',
  'status',
  'preview',
  'draft',
]);
const MCP_RULES: [RegExp, ProtectedActionCategory][] = [
  [/^(pay|payment|charge|purchase|refund|payout|transfer)$/, 'payment'],
  [/^(deploy|publish|release|promote|rollout)$/, 'deploy'],
  [/^(delete|remove|drop|destroy|purge|truncate|wipe|erase)$/, 'delete'],
  [/^(send|email|mail|sms|tweet|reply|post|notify|broadcast|forward)$/, 'external-send'],
];

function classifyMcpTool(name: string): ProtectedActionCategory | null {
  const tokens = words(name).map((w) => w.toLowerCase());
  if (tokens.some((t) => READ_VERBS.has(t))) return null;
  for (const [rule, category] of MCP_RULES) if (tokens.some((t) => rule.test(t))) return category;
  return null;
}

/** read 不是 ApprovalKind：只读工具（read/grep）只有底线会拦（读取密钥文件），平时免审 */
export function classifyProtectedTool(
  toolName: string,
  kind: ApprovalKind | 'read',
  params: unknown
): ProtectedActionCategory | null {
  const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  if (kind === 'command') {
    return typeof record.command === 'string' ? classifyProtectedCommand(record.command) : null;
  }
  if (kind === 'read') {
    const path = record.path ?? record.file_path;
    if (typeof path === 'string') {
      const expanded = expandPiToolPath(path);
      if (isSecretFilePath(expanded) || isUnderSecretDirectory(expanded)) return 'secret';
    }
    // grep 的 --glob 会越过 .gitignore，glob 直接点名密钥文件等同显式读取它
    return typeof record.glob === 'string' && globTargetsSecrets(record.glob) ? 'secret' : null;
  }
  if (kind === 'mcp') return classifyMcpTool(toolName);
  return null;
}
