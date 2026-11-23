import { spawn } from 'node:child_process';

export interface CommandGuardHit {
  ruleId: string;
  reason: string;
}

/** 命令守卫：命中返回规则与原因；出错 / 超时 / 不适用一律 null（fail-open，交回原审批逻辑） */
export type CommandGuard = (
  tool: string,
  command: string,
  signal?: AbortSignal
) => Promise<CommandGuardHit | null>;

export function dcgDialect(tool: string): 'posix' | 'ps' | null {
  if (tool === 'bash') return 'posix';
  if (tool === 'powershell') return 'ps';
  return null;
}

export function parseDcgVerdict(exitCode: number | null, stdout: string): CommandGuardHit | null {
  if (exitCode !== 1) return null;
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    if (value.decision !== 'deny') return null;
    const { rule_id: ruleId, reason } = value;
    if (typeof ruleId !== 'string' || !ruleId || typeof reason !== 'string' || !reason) return null;
    return { ruleId, reason };
  } catch {
    return null;
  }
}

const MAX_OUTPUT = 64 * 1024;

export const TEMP_ROOT_RULE_ID = 'enso.windows:temp-root-delete';
export const TEMP_ROOT_REASON =
  'Deletes in the shared system Temp folder root, which holds files of other apps; delete only inside the session temp folder.';

const TEMP_TOKEN = [
  String.raw`\$env:(?:TEMP|TMP)`,
  String.raw`\$\{env:(?:TEMP|TMP)\}`,
  '%(?:TEMP|TMP)%',
  String.raw`(?:\$env:LOCALAPPDATA|\$\{env:LOCALAPPDATA\}|%LOCALAPPDATA%)[\\/]+Temp`,
  String.raw`(?:~|\$HOME|\$env:USERPROFILE|%USERPROFILE%|[A-Z]:[\\/]+Users[\\/]+[^\\/\s'"]+)[\\/]+AppData[\\/]+Local[\\/]+Temp`,
  String.raw`[A-Z]:[\\/]+Windows[\\/]+Temp`,
  String.raw`\[(?:System\.)?IO\.Path\]::GetTempPath\(\)`,
  // macOS / Linux：/tmp、/var/tmp、/private/tmp 与 $TMPDIR；./tmp、build/tmp 这类项目内路径不算
  String.raw`(?<![\w.~$/-])(?:/private)?(?:/var)?/tmp`,
  String.raw`\$\{?TMPDIR\}?`,
].join('|');
const PATH_STOP = String.raw`\s'"\x60;|,)&}`;
/** Temp 根本身或根下带通配的一层（`\*`、`\*.tmp`、`tmp*`）；后面跟具体子目录名的不算 */
const TEMP_ROOT_REF = new RegExp(
  String.raw`(?:${TEMP_TOKEN})(?:[\\/]+(?:[^\\/${PATH_STOP}]*[*?][^\\/${PATH_STOP}]*)?)?(?=$|[${PATH_STOP}*])`,
  'i'
);
const DELETE_VERB =
  /(?:^|[\s;|&({'"])(?:Remove-Item|ri|rm|rmdir|rd|del|erase)(?=\s|$)|\.Delete\s*\(/i;

/** 命令里有删除动作且引用了系统 Temp 根：全系统共用目录，误删会伤到别的程序 */
export function deletesTempRoot(command: string): boolean {
  return DELETE_VERB.test(command) && TEMP_ROOT_REF.test(command);
}

/** 内置 Temp 根删除规则先于 dcg 判定；未安装 dcg 时同样生效 */
export function withTempRootGuard(inner: CommandGuard | undefined): CommandGuard {
  return (tool, command, signal) => {
    if (dcgDialect(tool) && deletesTempRoot(command)) {
      return Promise.resolve({ ruleId: TEMP_ROOT_RULE_ID, reason: TEMP_ROOT_REASON });
    }
    return inner ? inner(tool, command, signal) : Promise.resolve(null);
  };
}

export function createDcgGuard(binaryPath: string, timeoutMs = 1500): CommandGuard {
  return (tool, command, signal) => {
    const dialect = dcgDialect(tool);
    if (!dialect || !command.trim() || signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let stdout = '';
      let settled = false;
      const child = spawn(binaryPath, ['--robot', 'test', '--dialect', dialect, command], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, DCG_ROBOT: '1' },
      });
      const finish = (hit: CommandGuardHit | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(hit);
      };
      const onAbort = () => {
        child.kill('SIGKILL');
        finish(null);
      };
      const timer = setTimeout(onAbort, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(0, MAX_OUTPUT);
      });
      child.on('error', () => finish(null));
      child.on('close', (code) => finish(parseDcgVerdict(code, stdout)));
    });
  };
}
