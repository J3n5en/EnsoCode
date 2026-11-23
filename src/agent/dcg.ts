import { spawn } from 'node:child_process';
import { isDcgRuleExemptible } from '@shared/dcgRuleMemory';
import {
  DCG_EXPLANATION_MAX,
  DCG_GUARD_DECISIONS,
  DCG_MATCHED_MAX,
  DCG_SEVERITIES,
  type DcgGuardHit,
  type DcgSeverity,
} from '@shared/types/dcg';

export type CommandGuardHit = DcgGuardHit;

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

/** warn 只提示不拦；缺省 decision 视同 deny */
export const isBlockingGuardHit = (hit: CommandGuardHit): boolean => hit.decision !== 'warn';

/** matched_span 是 command 的 UTF-8 字节区间 */
function matchedText(command: unknown, span: unknown): string | undefined {
  if (typeof command !== 'string' || !Array.isArray(span) || span.length !== 2) return undefined;
  const [start, end] = span;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start)
    return undefined;
  const bytes = Buffer.from(command);
  if (end > bytes.length) return undefined;
  const text = bytes.subarray(start, end).toString().trim();
  return text ? text.slice(0, DCG_MATCHED_MAX) : undefined;
}

/** 按 robot JSON 的 decision 判定，不看退出码（warn 退出 0）；被杀（无退出码）或解析失败 fail-open */
export function parseDcgVerdict(exitCode: number | null, stdout: string): CommandGuardHit | null {
  if (exitCode === null) return null;
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const { decision, rule_id: ruleId, reason, severity, explanation } = record;
    if (!(DCG_GUARD_DECISIONS as readonly unknown[]).includes(decision)) return null;
    if (typeof ruleId !== 'string' || !ruleId || typeof reason !== 'string' || !reason) return null;
    const matched = matchedText(record.command, record.matched_span);
    return {
      ruleId,
      reason,
      decision: decision as CommandGuardHit['decision'],
      ...((DCG_SEVERITIES as readonly unknown[]).includes(severity)
        ? { severity: severity as DcgSeverity }
        : {}),
      ...(typeof explanation === 'string' && explanation.trim()
        ? { explanation: explanation.trim().slice(0, DCG_EXPLANATION_MAX) }
        : {}),
      ...(matched ? { matched } : {}),
    };
  } catch {
    return null;
  }
}

const MAX_OUTPUT = 64 * 1024;

/** 用户按规则记忆的豁免：命中豁免规则视同未命中，交回原审批逻辑 */
export function withDcgExemptions(
  guard: CommandGuard,
  exemptRules: readonly string[]
): CommandGuard {
  const allowed = exemptRules.filter(isDcgRuleExemptible);
  if (allowed.length === 0) return guard;
  const exempt = new Set(allowed);
  return async (tool, command, signal) => {
    const hit = await guard(tool, command, signal);
    return hit && exempt.has(hit.ruleId) ? null : hit;
  };
}

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
