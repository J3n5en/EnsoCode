import type { ApprovalKind, ProtectedActionCategory } from '@shared/types/agent';

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

/** 把一段命令拆成去引号的 token，并剥掉 env 赋值与 sudo/xargs 之类的包装程序 */
export function programTokens(segment: string): string[] {
  let tokens = segment.trim().split(/\s+/).map(unquote).filter(Boolean);
  for (;;) {
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
    const head = basename(tokens[0] ?? '');
    if (WRAPPERS.has(head)) {
      tokens = tokens.slice(1);
      while (tokens.length && tokens[0].startsWith('-')) tokens = tokens.slice(1);
      continue;
    }
    if (head === 'timeout') {
      tokens = tokens.slice(1).filter((t, i) => i > 0 || !/^\d/.test(t));
      continue;
    }
    return tokens;
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

/** read 不是 ApprovalKind：只有底线会拦它（读取密钥文件），平时免审 */
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
    return typeof path === 'string' && isSecretFilePath(path) ? 'secret' : null;
  }
  if (kind === 'mcp') return classifyMcpTool(toolName);
  return null;
}
