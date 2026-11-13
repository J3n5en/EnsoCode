/** 只读 bash 白名单：段首程序在这里且无写副作用标志才算只读（env/xargs/tee 等能转执行或写文件的不收） */
const READ_ONLY_PROGRAMS = new Set([
  'ls',
  'tree',
  'pwd',
  'cd',
  'cat',
  'bat',
  'head',
  'tail',
  'wc',
  'nl',
  'tac',
  'less',
  'more',
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'ag',
  'find',
  'fd',
  'fdfind',
  'which',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'sort',
  'uniq',
  'cut',
  'tr',
  'awk',
  'sed',
  'diff',
  'jq',
  'yq',
  'echo',
  'printf',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'printenv',
  'date',
  'whoami',
  'uname',
  'column',
  'true',
  'test',
  '[',
  'git',
]);
const GIT_READ_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'grep',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'describe',
  'shortlog',
  'reflog',
  'cat-file',
  'name-rev',
  'remote',
  'config',
  'branch',
  'tag',
]);
/**
 * 各程序里会写文件 / 转执行的参数，命中即非只读。
 * 短参数按组合（-uo）与粘连值（-fx.awk）匹配：写字母出现在组合里任意位置都算，宁可误判为写。
 */
const WRITE_FLAGS: Record<string, RegExp> = {
  sed: /^(-[a-zA-Z]*i|--in-place)|\/[a-zA-Z]*e[a-zA-Z]*['"]?$|^['"]?e\b/,
  awk: /^-[a-zA-Z]*[fiE]|^--(file|include|exec)/,
  // -s/--split-exp 按表达式把结果写成多个文件
  yq: /^-[a-zA-Z]*[is]|^--(inplace|split-exp)/,
  sort: /^-[a-zA-Z]*o|^--(output|compress-program)/,
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fprint0|fls)$/,
  git: /^--(output|ext-diff|textconv|filters|exec-path)/,
  rg: /^--pre($|=)/,
  fd: /^-[a-zA-Z0-9]*[xX]|^--exec/,
  fdfind: /^-[a-zA-Z0-9]*[xX]|^--exec/,
  ag: /^--pager/,
  bat: /^--pager/,
  tree: /^-o$|^--output/,
  file: /^-[a-zA-Z]*C/,
  date: /^(-s|--set)/,
};
/** git 只读子命令里带这些参数就是写：branch -d / tag -a / config --unset / remote add … */
const GIT_WRITE_ARGS: Record<string, RegExp> = {
  branch: /^-(d|D|m|M|c|C|u|f|-delete|-move|-copy|-set-upstream-to|-unset-upstream|-force)/,
  tag: /^-(a|s|d|f|m|F|-annotate|-sign|-delete|-force|-message)/,
  config: /^(-e|--edit|--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section)$/,
  remote: /^(add|remove|rm|rename|set-url|set-head|set-branches|prune|update)$/,
  reflog: /^(expire|delete)$/,
  grep: /^(-O|--open-files-in-pager)/,
};
/** 带路径的程序只认系统 bin 目录：./scripts/cat 之类可能是工作区里与只读工具同名的脚本 */
const SYSTEM_BIN_PATH = /^\/(usr\/(local\/)?)?s?bin\/[^/]+$|^\/opt\/homebrew\/bin\/[^/]+$/;
/** 子命令前允许出现的 git 全局参数；-c / --config-env 可改 pager、diff 驱动转执行 */
const GIT_SAFE_GLOBAL_FLAGS = new Set(['--no-pager', '-P', '--no-optional-locks']);
/** 可改变程序行为的环境变量（LESSOPEN、RIPGREP_CONFIG_PATH、GIT_* …）一律不认，只放行语言/显示类 */
const SAFE_ENV =
  /^(LC_[A-Z_]+|LANG|LANGUAGE|TZ|NO_COLOR|FORCE_COLOR|CLICOLOR(_FORCE)?|COLUMNS|TERM)=/;
/** 解释器 / 包管理器只认查版本：`node --version`、`pnpm -v` */
const VERSION_ONLY_PROGRAMS = new Set([
  'node',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'python',
  'python3',
  'pip',
  'pip3',
  'ruby',
  'go',
  'cargo',
  'rustc',
  'java',
  'javac',
]);
/** sed 只认纯打印脚本：`1,20p`、`/re/p` */
const SED_PRINT_SCRIPT = /^['"]?((\d+|\$)(,(\d+|\$))?|\/[^/]*\/)p['"]?$/;
const SED_SAFE_FLAGS = new Set(['-n', '-E', '-r', '--quiet', '--silent']);

function splitEnvPrefix(segment: string): { env: string[]; tokens: string[] } {
  const tokens = segment.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  return { env: tokens.slice(0, i), tokens: tokens.slice(i) };
}

export function firstProgram(segment: string): string {
  const head = splitEnvPrefix(segment).tokens[0] ?? '';
  return head.slice(head.lastIndexOf('/') + 1);
}

function hasC0Control(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f && code !== 0x0a) return true;
  }
  return false;
}

function isReadOnlySed(args: string[]): boolean {
  const script = args.find((t) => !SED_SAFE_FLAGS.has(t));
  if (!script || !SED_PRINT_SCRIPT.test(script)) return false;
  return args.slice(0, args.indexOf(script)).every((t) => SED_SAFE_FLAGS.has(t));
}

function isReadOnlyGit(tokens: string[]): boolean {
  // `-C <dir>` 只切目录，跳过它和它的参数再找子命令
  let subIndex = 1;
  while (subIndex < tokens.length && tokens[subIndex].startsWith('-')) {
    if (tokens[subIndex] === '-C') {
      if (subIndex + 1 >= tokens.length) return false;
      subIndex += 2;
    } else if (GIT_SAFE_GLOBAL_FLAGS.has(tokens[subIndex])) subIndex += 1;
    else return false;
  }
  if (subIndex >= tokens.length) return false;
  const sub = tokens[subIndex];
  if (!GIT_READ_SUBCOMMANDS.has(sub)) return false;
  const args = tokens.slice(subIndex + 1);
  const writeArg = GIT_WRITE_ARGS[sub];
  if (writeArg && args.some((t) => writeArg.test(t))) return false;
  // git config 只读形态：--get/--list/-l；裸 `git config a b` 是写
  if (sub === 'config' && !args.some((t) => /^(--get|--get-all|--list|-l|--get-regexp)$/.test(t)))
    return false;
  // branch / tag 带位置参数是新建；只有 --list/-l 下的位置参数是过滤模式
  if (
    (sub === 'branch' || sub === 'tag') &&
    args.some((t) => !t.startsWith('-')) &&
    !args.some((t) => t === '-l' || t === '--list')
  )
    return false;
  return true;
}

/**
 * 判定一条 bash 命令是否纯只读（ls/rg/cat/git status …）。
 * 仅供展示：精简模式据此把命令折进探索组，不参与任何免询问放行（Plan 模式自 4a05088a 起不再用它）。
 * 策略保守（宁可误判为写）：重定向、命令/进程替换、后台 &、写参数、未知程序、
 * 非系统目录的带路径程序、非语言类环境前缀一律判非只读。
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // 命令替换 / 进程替换 / 反引号可藏任意命令；控制字符（\r 等）可拼接隐藏命令
  if (/\$\(|<\(|`/.test(trimmed) || hasC0Control(trimmed)) return false;
  // 去掉无害的 stderr 重定向后，剩余任何 > 都视为写文件
  const withoutStderr = trimmed.replace(/2>&1|[12]?>\s*\/dev\/null/g, '');
  if (withoutStderr.includes('>')) return false;
  // 段分隔：| || && ; & 换行（单个 & 是后台执行，同样开新命令）
  const segments = withoutStderr.split(/\|\|?|&&?|;|\n/);
  for (const raw of segments) {
    const segment = raw.trim();
    if (!segment) continue;
    const { env, tokens } = splitEnvPrefix(segment);
    if (env.some((e) => !SAFE_ENV.test(e))) return false;
    const program = firstProgram(segment);
    const head = tokens[0] ?? '';
    if (head.includes('/') && !SYSTEM_BIN_PATH.test(head)) return false;
    const args = tokens.slice(1);
    if (VERSION_ONLY_PROGRAMS.has(program)) {
      if (args.length !== 1 || !['--version', '-v', '-V'].includes(args[0])) return false;
      continue;
    }
    if (!READ_ONLY_PROGRAMS.has(program)) return false;
    const writeFlag = WRITE_FLAGS[program];
    if (writeFlag && args.some((t) => writeFlag.test(t))) return false;
    // 按空白切出的 token 会把 `system ("…")` 拆成两段，只能对整段程序文本判断
    if (program === 'awk' && /system\s*\(/.test(args.join(' '))) return false;
    if (program === 'sed' && !isReadOnlySed(args)) return false;
    if (program === 'git' && !isReadOnlyGit(tokens)) return false;
    // uniq IN OUT：第二个位置参数是输出文件
    if (program === 'uniq' && args.filter((t) => !t.startsWith('-')).length > 1) return false;
  }
  return true;
}
