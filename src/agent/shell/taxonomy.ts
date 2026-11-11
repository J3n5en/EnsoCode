import type { ShellFailureKind } from '@shared/types/agent';

export interface FailureInput {
  exitCode?: number | null;
  signal?: string | null;
  /** 输出尾部（判定用，几 KB 足够） */
  tail: string;
  killedByDeadline?: boolean;
  /** 截止时间（秒），仅用于提示文案 */
  deadlineSec?: number;
  stoppedByUser?: boolean;
  /** 日志超限后未写入的字节数 */
  droppedBytes?: number;
}

export interface FailureVerdict {
  kind: ShellFailureKind | 'none';
  /** false：原样重跑不会有不同结果，必须换写法或交给用户 */
  retryable: boolean;
  /** 给模型的下一步（英文，单段） */
  hint: string;
}

/** 判定只看输出尾部：开头的命令回显 / 日志不应左右分类 */
const TAIL_CHARS = 4_000;

/** 需要终端：没有 TTY 的环境里注定失败（Factory 逆向列表，大小写不敏感子串） */
const TTY_PATTERNS: readonly string[] = [
  'not a terminal',
  'no tty present',
  'not a tty',
  'inappropriate ioctl for device',
  'must be run from a terminal',
  'requires a terminal',
  'terminal is not interactive',
  'stdin is not a terminal',
  'stdout is not a terminal',
  'the input device is not a tty',
  'cannot open terminal',
  'terminal not fully functional',
  // Factory 列表之外的补充：这些真实报错的措辞不含上面的子串，删掉就退化成普通非零退出
  'a terminal is required',
  'pseudo-terminal will not be allocated',
  'input is not from a terminal',
  // stdin 关闭 + 硬化 env 下的真机原文；editor 不绑定具体值（硬化 env 设的是 false，远端可能是 vim）
  'there was a problem with the editor',
  'eof when reading a line',
];

/** 需要认证：凭证 / 登录无法在这里输入（Factory 逆向列表，大小写不敏感子串） */
const AUTH_PATTERNS: readonly string[] = [
  'permission denied (publickey)',
  'could not read username',
  'could not read password',
  'host key verification failed',
  'authentication failed',
  'invalid username or password',
  'terminal prompts disabled',
  'no more authentication methods to try',
  // 带 sudo 前缀：别的 CLI 自己报的同句文案多是可修的失败，判成需认证会让模型停止排查
  'sudo: a password is required',
  'enter passphrase for',
];

const NOT_FOUND_PATTERNS: RegExp[] = [
  /command not found/i,
  /is not recognized as (?:an internal or external command|the name of a cmdlet)/i,
];

/**
 * `source ~/.zshrc` 这类命令失败时，bash 会替被 source 的文件报
 * `~/.zshrc: line 6: autoload: command not found` —— 那是配置文件里的命令在当前 shell 不存在，
 * 不是我们调用的程序缺失。命中这些行不能判 not_found，否则会给模型错误的下一步（去查 PATH / 装包）。
 */
const SOURCED_CONFIG_LINE =
  /\bline \d+:|(?:^|[\s/])\.(?:zshrc|zprofile|zlogin|bashrc|bash_profile|profile|kshrc)\b/i;

/** 尾部存在「不是配置文件加载噪音」的 command-not-found 才算程序缺失 */
function notFoundInTail(tail: string, exitCode: number | null | undefined): boolean {
  const hit = tail
    .split('\n')
    .filter((line) => NOT_FOUND_PATTERNS.some((pattern) => pattern.test(line)))
    .some((line) => !SOURCED_CONFIG_LINE.test(line));
  if (hit) return true;
  return exitCode === 127 && !SOURCED_CONFIG_LINE.test(tail);
}

/** 除 \t\n\r 与 ESC（ANSI 序列）外的控制字符，及解码失败的替换字符 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 判定二进制输出需要匹配控制字符
const BINARY_CHAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\ufffd]/g;

function looksBinary(text: string): boolean {
  if (!text) return false;
  if (text.includes('\u0000')) return true;
  const hits = text.match(BINARY_CHAR)?.length ?? 0;
  return hits / text.length > 0.1;
}

const verdict = (kind: FailureVerdict['kind'], retryable: boolean, hint: string) => ({
  kind,
  retryable,
  hint,
});

export function classifyFailure(input: FailureInput): FailureVerdict {
  if (input.stoppedByUser) {
    return verdict(
      'stopped_by_user',
      false,
      'The user stopped this command. Do not restart it unless the user asks.'
    );
  }
  if (input.killedByDeadline) {
    const at = input.deadlineSec ? ` at the ${Math.round(input.deadlineSec)}s limit you set` : '';
    return verdict(
      'deadline',
      true,
      `It was killed${at} — that is not a failure of the command itself. If it legitimately needs longer, run it once more with a larger timeout or with background: true; if it should have finished, find out why it hangs instead of rerunning it.`
    );
  }
  const tail = (input.tail ?? '').slice(-TAIL_CHARS);
  const lower = tail.toLowerCase();
  const failed = input.exitCode !== 0;
  if (failed) {
    if (TTY_PATTERNS.some((pattern) => lower.includes(pattern))) {
      return verdict(
        'tty_required',
        false,
        'This command needs an interactive terminal, which this shell does not have. Use a non-interactive form (flags such as --yes / -y / --no-input / --non-interactive, or input supplied via a pipe or file), or ask the user to run it themselves. Do not retry it unchanged.'
      );
    }
    if (AUTH_PATTERNS.some((pattern) => lower.includes(pattern))) {
      return verdict(
        'auth_required',
        false,
        'This command needs credentials or a login that cannot be entered here. Ask the user to authenticate (or to provide a token through their existing config), then retry. Do not retry it unchanged.'
      );
    }
    if (notFoundInTail(tail, input.exitCode)) {
      return verdict(
        'not_found',
        true,
        "The program was not found. Check the name and PATH, install it, or use the project's local binary (npx / pnpm exec / ./node_modules/.bin)."
      );
    }
    if (input.exitCode === 126) {
      return verdict(
        'not_executable',
        true,
        'The file is not executable. Run it through its interpreter (sh / node / python) or chmod +x it first.'
      );
    }
  }
  if (looksBinary(tail)) {
    return verdict(
      'binary_output',
      true,
      'The output is binary. Write it to a file, or inspect it with file / xxd / strings instead of printing it.'
    );
  }
  if (failed) {
    const code =
      typeof input.exitCode === 'number'
        ? `exit code ${input.exitCode}`
        : input.signal
          ? `signal ${input.signal}`
          : 'no exit code';
    return verdict(
      'exit_nonzero',
      true,
      `The command failed (${code}). Read the error output, fix the cause, then rerun — do not rerun it unchanged.`
    );
  }
  if (input.droppedBytes && input.droppedBytes > 0) {
    return verdict(
      'output_truncated',
      true,
      'The log stopped recording after reaching its size limit, so the end of the output is missing. Rerun with the output filtered (grep / tail) or redirected to a file if you need it.'
    );
  }
  return verdict('none', true, '');
}
