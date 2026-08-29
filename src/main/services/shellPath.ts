import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';

/**
 * macOS/Linux GUI 启动的 Electron 继承的是 launchd/桌面会话的极简环境，
 * PATH 缺 homebrew/nvm 等用户目录，pi 的 bash、MCP stdio 子进程会找不到
 * node/git。两段式修复（参考 orca 的方案）：
 *   1. seedProcessPath()：启动即前插常见安装目录，零延迟保底；
 *   2. hydrateShellPath()：异步跑登录 shell 拿真实 $PATH 合并提升。
 * 只动 PATH，不整包导入用户 env——密钥走应用设置，杂音不进 agent 子进程。
 */

const MARKER = `__ENSO_SHELL_PATH_${process.pid}__`;
/** 重型 rc（nvm+conda+gcloud）冷启动实测可到 6-7s，预算对齐成熟 GUI 编辑器 */
const PROBE_TIMEOUT_MS = 10_000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 剥 ANSI 转义需要匹配 ESC
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** 解析探测输出：成对标记之间的 $PATH，剥 ANSI、去重保序 */
export function parseProbeOutput(stdout: string, marker: string): string[] {
  const cleaned = stdout.replace(ANSI_RE, '');
  const first = cleaned.indexOf(marker);
  if (first === -1) return [];
  const second = cleaned.indexOf(marker, first + marker.length);
  if (second === -1) return [];
  const value = cleaned.slice(first + marker.length, second).trim();
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(delimiter)
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

/** shell 段前插（优先于现有段），整体去重；无变化返回原值 */
export function mergePathSegments(segments: string[], currentPath: string): string {
  if (segments.length === 0) return currentPath;
  const current = currentPath.split(delimiter).filter(Boolean);
  const shellSet = new Set(segments);
  const merged = [...segments, ...current.filter((s) => !shellSet.has(s))];
  return merged.join(delimiter);
}

/** 打包版保底目录：homebrew / usr-local / nix / 用户级 bin */
export function seedPathEntries(platform: NodeJS.Platform, home: string): string[] {
  const entries = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin'];
  if (platform === 'linux') entries.push('/snap/bin', '/home/linuxbrew/.linuxbrew/bin');
  entries.push('/nix/var/nix/profiles/default/bin');
  if (home) {
    entries.push(`${home}/bin`, `${home}/.local/bin`, `${home}/.nix-profile/bin`);
  }
  return entries;
}

/** 同步前插保底目录到 process.env.PATH（仅打包版、非 Windows 调用） */
export function seedProcessPath(): void {
  const seeded = mergePathSegments(
    seedPathEntries(process.platform, process.env.HOME ?? ''),
    process.env.PATH ?? ''
  );
  process.env.PATH = seeded;
}

/**
 * 跑登录 shell（-ilc，含 rc 文件）拿真实 $PATH，成功则提升到 process.env.PATH
 * 最前（shell 结果优先于 seed——seed 里的 node 可能不是用户 shell 实际解析的
 * 那个版本）。失败静默保留 seed。分辨率一次，进程内不重复探测。
 */
export async function hydrateShellPath(): Promise<{ ok: boolean; added: number }> {
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const command = `printf '%s' '${MARKER}'; printf '%s' "$PATH"; printf '%s' '${MARKER}'`;

  const stdout = await new Promise<string>((resolve) => {
    let out = '';
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // 不接 stderr：oh-my-zsh/p10k 启动会往 stderr 打大量输出
      child = spawn(shell, ['-ilc', command], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish('');
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish('');
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish(out);
    });
  });

  const segments = parseProbeOutput(stdout, MARKER);
  if (segments.length === 0) return { ok: false, added: 0 };
  const before = process.env.PATH ?? '';
  const next = mergePathSegments(segments, before);
  process.env.PATH = next;
  return { ok: true, added: next === before ? 0 : segments.length };
}
