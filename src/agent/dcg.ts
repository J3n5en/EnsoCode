import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDcgRuleExemptible } from '@shared/dcgRuleMemory';
import {
  DCG_EXPLANATION_MAX,
  DCG_GUARD_DECISIONS,
  DCG_MATCHED_MAX,
  DCG_SEVERITIES,
  type DcgGuardHit,
  type DcgSeverity,
  TEMP_ROOT_RULE_ID,
} from '@shared/types/dcg';

export { TEMP_ROOT_RULE_ID };
export type CommandGuardHit = DcgGuardHit;

/** 命令守卫：命中返回规则与原因；出错 / 超时 / 不适用一律 null（fail-open，交回原审批逻辑） */
export type CommandGuard = (
  tool: string,
  command: string,
  signal?: AbortSignal,
  options?: { failClosedOnError?: boolean }
) => Promise<CommandGuardHit | null>;

export function dcgDialect(tool: string): 'posix' | 'ps' | null {
  if (tool === 'bash') return 'posix';
  if (tool === 'powershell') return 'ps';
  return null;
}

/** warn 只提示不拦；缺省 decision 视同 deny */
export const isBlockingGuardHit = (hit: CommandGuardHit): boolean => hit.decision !== 'warn';

export const DCG_INVALID_VERDICT_RULE_ID = 'enso.dcg:invalid-verdict';
const INVALID_OUTPUT_REASON = 'dcg returned invalid output; confirmation required.';
const ABNORMAL_ALLOW_REASON =
  'dcg exited abnormally despite allow decision; confirmation required.';
const MALFORMED_WARNING_REASON = 'dcg returned malformed warning; confirmation required.';
const UNKNOWN_DECISION_REASON = 'dcg returned an unknown decision; confirmation required.';
const MISSING_DETAILS_REASON = 'dcg required confirmation without details.';

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

function extraFields(record: Record<string, unknown>) {
  const { severity, explanation } = record;
  const matched = matchedText(record.command, record.matched_span);
  return {
    ...((DCG_SEVERITIES as readonly unknown[]).includes(severity)
      ? { severity: severity as DcgSeverity }
      : {}),
    ...(typeof explanation === 'string' && explanation.trim()
      ? { explanation: explanation.trim().slice(0, DCG_EXPLANATION_MAX) }
      : {}),
    ...(matched ? { matched } : {}),
  };
}

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * 按 robot JSON 的 decision 判定：
 * - 仅 exitCode=0 且 decision="allow" 放行（null）；
 * - warn 需完整 rule_id/reason 才按提示放行，否则升级为 ask；
 * - deny / ask 按原档拦截或确认，缺字段用不可豁免内置规则兜底；
 * - 未知/格式错的 decision、坏 JSON 或非零退出码一律按 ask 走确认（fail-closed，绝不默认放行）。
 * 进程被超时或用户中止杀掉（exitCode === null）时返回 null。
 */
export function parseDcgVerdict(exitCode: number | null, stdout: string): CommandGuardHit | null {
  if (exitCode === null) return null;
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {
        ruleId: DCG_INVALID_VERDICT_RULE_ID,
        reason: INVALID_OUTPUT_REASON,
        decision: 'ask',
      };
    }
    const record = value as Record<string, unknown>;
    const { decision } = record;
    if (decision === 'allow') {
      return exitCode === 0
        ? null
        : { ruleId: DCG_INVALID_VERDICT_RULE_ID, reason: ABNORMAL_ALLOW_REASON, decision: 'ask' };
    }
    const ruleId = nonEmptyString(record.rule_id);
    const reason = nonEmptyString(record.reason);
    const extras = extraFields(record);
    if (decision === 'warn') {
      if (!ruleId || !reason) {
        return {
          ruleId: DCG_INVALID_VERDICT_RULE_ID,
          reason: MALFORMED_WARNING_REASON,
          decision: 'ask',
        };
      }
      return { ruleId, reason, decision: 'warn', ...extras };
    }
    if ((DCG_GUARD_DECISIONS as readonly unknown[]).includes(decision)) {
      return {
        ruleId: ruleId ?? DCG_INVALID_VERDICT_RULE_ID,
        reason: reason ?? MISSING_DETAILS_REASON,
        decision: decision as CommandGuardHit['decision'],
        ...extras,
      };
    }
    return {
      ruleId: ruleId ?? DCG_INVALID_VERDICT_RULE_ID,
      reason: reason ?? UNKNOWN_DECISION_REASON,
      decision: 'ask',
      ...extras,
    };
  } catch {
    return { ruleId: DCG_INVALID_VERDICT_RULE_ID, reason: INVALID_OUTPUT_REASON, decision: 'ask' };
  }
}

const MAX_OUTPUT = 64 * 1024;

/** 用户按规则记忆的豁免：仅对普通可豁免规则的 deny 生效；绝不绕过 ask、不可豁免规则，也不吞 warn 提醒 */
export function withDcgExemptions(
  guard: CommandGuard,
  exemptRules: readonly string[]
): CommandGuard {
  const allowed = exemptRules.filter(isDcgRuleExemptible);
  if (allowed.length === 0) return guard;
  const exempt = new Set(allowed);
  return async (tool, command, signal, options) => {
    const hit = await guard(tool, command, signal, options);
    if (!hit) return null;
    const isDeny = hit.decision === undefined || hit.decision === 'deny';
    return isDeny && exempt.has(hit.ruleId) ? null : hit;
  };
}

export const TEMP_ROOT_REASON =
  'Deletes in the shared system Temp folder root, which holds files of other apps; delete only inside the session temp folder.';

const BASE_TEMP_TOKENS = [
  String.raw`\$env:(?:TEMP|TMP)`,
  String.raw`\$\{env:(?:TEMP|TMP)\}`,
  '%(?:TEMP|TMP)%',
  String.raw`(?:\$env:LOCALAPPDATA|\$\{env:LOCALAPPDATA\}|%LOCALAPPDATA%)[\\/]+Temp`,
  String.raw`(?:~|\$HOME|\$env:USERPROFILE|%USERPROFILE%|[A-Z]:[\\/]+Users[\\/]+[^\\/\s'"]+)[\\/]+AppData[\\/]+Local[\\/]+Temp`,
  String.raw`[A-Z]:[\\/]+Windows[\\/]+Temp`,
  String.raw`\[(?:System\.)?IO\.Path\]::GetTempPath\(\)`,
  // macOS / Linux：/tmp、/var/tmp、/private/tmp 与 $TMPDIR；./tmp、build/tmp 这类项目内路径不算
  String.raw`(?<![\w.~$/-])(?:/private)?(?:/var)?/tmp`,
  String.raw`\$TMPDIR`,
  String.raw`\$\{TMPDIR\}`,
];
const PATH_STOP = String.raw`\s'"\x60;|,)&}`;
const DELETE_VERB =
  /(?:^|[\s;|&({'"])(?:Remove-Item|ri|rm|rmdir|rd|del|erase)(?=\s|$)|\.Delete\s*\(|(?:^|[\s;|&({'"])find\s+[\s\S]*(?:-delete(?=\s|$)|-exec(?:dir)?\s+(?:rm|unlink|shred)\b)/i;
const SHELL_INTERPRETER =
  /(?:^|[\s;|&({'"])(?:(?:[A-Za-z]:)?[\\/][^\s;|&({'"]*[\\/])?(?:sh|bash|zsh|dash|fish|ksh|pwsh|powershell|cmd)(?:\.exe)?(?=\s|$)/i;
const HEREDOC_START = /^<<(-)?(?!<)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_-]*))/;
const CD_STMT = /^(?:cd|pushd|Set-Location|sl)(?:\s+([\s\S]+))?$/i;
const TEMP_ENV_MUTATION =
  /(?:^|[\s;|&({'"])(?:(?:export|declare|local|typeset|readonly)\s+[^;\n]*\b(?:TMPDIR|TEMP|TMP|LOCALAPPDATA)\b|(?:TMPDIR|TEMP|TMP|LOCALAPPDATA)=|unset\s+[^;\n]*\b(?:TMPDIR|TEMP|TMP|LOCALAPPDATA)\b|\$env:(?:TEMP|TMP|LOCALAPPDATA)\s*=|(?:Set-Item|Remove-Item|Clear-Item|si|ri|del)\s+(?:[^;\n]*[\s'"])?(?<![$])Env:[\\/]?(?:TEMP|TMP|LOCALAPPDATA)\b)/i;
const SYMLINK_CREATION =
  /(?:^|[\s;|&({'"])(?:ln|mklink)(?=\s|$)|(?:SymbolicLink|Junction|HardLink)\b/i;
const UNSAFE_SUBPATH_META = /[*?[\]{},;$`%~]/;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normalizedTmpDir(raw?: string): string | null {
  const candidate = (raw ?? tmpdir()).trim().replace(/[\\/]+$/, '');
  if (!candidate || !path.isAbsolute(candidate)) return null;
  if (path.parse(path.resolve(candidate)).root === path.resolve(candidate)) return null;
  return candidate;
}

/** tmpDir 为 null：不加本机运行时 Temp 路径（判远端命令用） */
function tempTokensFor(tmpDir?: string | null): string {
  const extra = tmpDir === null ? null : normalizedTmpDir(tmpDir);
  const tokens = [...BASE_TEMP_TOKENS];
  if (extra && !/^\/(?:private\/)?(?:var\/)?tmp$/i.test(extra)) {
    const escaped = escapeRegExp(extra).replace(/(?:\\\/|\\\\)+/g, '[\\\\/]+');
    tokens.push(String.raw`(?<![\w.~$/-])${escaped}`);
  }
  return tokens.join('|');
}

interface TempRootMatcher {
  rootRef: RegExp;
  exactRoot: RegExp;
}

function buildTempRootMatcher(tmpDir?: string | null): TempRootMatcher {
  const tokens = tempTokensFor(tmpDir);
  // 1) Temp 根本身或根/. 2) 根下带通配或花括号/字符类展开的一层（*、*.tmp、{,}） 3) 根下含 .. 穿越回根
  // 4) 根下某一段整段由变量/命令替换展开（/tmp/$X）：可能为空或 ..，无法确定不是根
  const rootRef = new RegExp(
    [
      String.raw`(?:${tokens})(?:[\\/]+\.?)?(?=$|[${PATH_STOP}*])`,
      String.raw`(?:${tokens})[\\/]+[^\\/${PATH_STOP}]*[*?[\]{}][^\\/${PATH_STOP}]*(?=$|[${PATH_STOP}])`,
      String.raw`(?:${tokens})[\\/]+(?:[^\\/${PATH_STOP}]+[\\/])*\.\.(?=$|[\\/${PATH_STOP}])`,
      String.raw`(?:${tokens})(?:[\\/]+[^\\/${PATH_STOP}]+)*[\\/]+[$\x60%]`,
    ].join('|'),
    'i'
  );
  const exactRoot = new RegExp(String.raw`^(?:${tokens})[\\/]*\.?$`, 'i');
  return { rootRef, exactRoot };
}

/** 在单行引号外查找 heredoc 起点（忽略 echo "<<EOF" 等字符串里的伪 heredoc） */
function findUnquotedHeredoc(line: string): { stripTabs: boolean; delim: string } | null {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < line.length) i++;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    if (ch === '<' && line[i + 1] === '<' && line[i - 1] !== '<') {
      const match = HEREDOC_START.exec(line.slice(i));
      if (match) {
        const delim = match[2] ?? match[3] ?? match[4];
        if (delim) return { stripTabs: match[1] === '-', delim };
      }
    }
  }
  return null;
}

/** 剥离非 shell 解释器的 heredoc 数据正文（如 python3 / cat），保留命令头；shell heredoc 原样保留 */
function stripNonShellHeredocs(command: string): string {
  const lines = command.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const heredoc = findUnquotedHeredoc(line);
    if (!heredoc || SHELL_INTERPRETER.test(line)) continue;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = heredoc.stripTabs ? lines[j].replace(/^\t+/, '') : lines[j];
      if (candidate.trimEnd() === heredoc.delim) {
        end = j;
        break;
      }
    }
    // 未闭合 heredoc 保守不吞，防止畸形输入掩盖后续命令
    if (end !== -1) i = end;
  }
  return out.join('\n');
}

/** 剥离引号外的 # 行注释，保留换行作为语句分隔 */
function stripShellComments(text: string): string {
  let out = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[++i];
      } else if (ch === '"') {
        quote = null;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      out += ch + text[++i];
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      while (i < text.length && text[i] !== '\n') i++;
      if (i < text.length) out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/** 按引号外 ; / && / || / 后台 & / 换行 拆分为独立语句；管道 | 保持在同一语句内 */
function splitShellStatements(text: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      current += ch;
      if (ch === '\\' && i + 1 < text.length) current += text[++i];
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      current += ch + text[++i];
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      flush();
      continue;
    }
    if ((ch === '&' && text[i + 1] === '&') || (ch === '|' && text[i + 1] === '|')) {
      flush();
      i++;
      continue;
    }
    // 后台执行符号 &（排除重定向 >&、<&、&>）同样作为语句分隔
    if (ch === '&' && text[i - 1] !== '>' && text[i - 1] !== '<' && text[i + 1] !== '>') {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return statements;
}

function tokenizeShell(stmt: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < stmt.length; i++) {
    const ch = stmt[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < stmt.length && /["\\$`\n]/.test(stmt[i + 1])) {
        current += stmt[++i];
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < stmt.length) {
      // Windows 路径里的反斜杠保留原样（如 C:\Users\...），仅转义空白与引号
      const next = stmt[i + 1];
      if (/[\s'"]/.test(next)) {
        current += next;
        i++;
      } else {
        current += ch;
      }
      hasToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote !== null) return null;
  if (hasToken) tokens.push(current);
  return tokens;
}

const stripOuterGroup = (stmt: string): string =>
  stmt.replace(/^[({\s]+/, '').replace(/[)}\s]+$/, '');

function cdTargetOf(stmt: string): string | null {
  const match = CD_STMT.exec(stripOuterGroup(stmt));
  if (!match) return null;
  const rest = match[1]?.trim();
  if (!rest) return '~';
  const tokens = tokenizeShell(rest);
  if (!tokens) return null;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--') return tokens[i + 1] ?? null;
    if (/^-(?:Path|LiteralPath)$/i.test(tok)) return tokens[i + 1] ?? null;
    if (tok.startsWith('-')) continue;
    return tok;
  }
  return null;
}

interface ParsedDeleteCommand {
  cmd: string;
  targets: string[];
  hasFilterOption: boolean;
}

function parseDeleteStatement(
  stmt: string,
  dialect: 'posix' | 'ps' | 'any'
): ParsedDeleteCommand | null {
  const tokens = tokenizeShell(stmt);
  if (!tokens || tokens.length < 2) return null;
  let i = 0;
  if (dialect !== 'ps') {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=[^$`()]*$/.test(tokens[i])) i++;
  }
  const cmd = tokens[i++];
  if (!cmd) return null;
  let afterDoubleDash = false;
  let hasFilterOption = false;
  const targets: string[] = [];
  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!afterDoubleDash && tok === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && tok.startsWith('-')) {
      if (dialect !== 'posix' && /^-(?:Path|LiteralPath)$/i.test(tok)) {
        if (i + 1 >= tokens.length) return null;
        targets.push(tokens[++i]);
        continue;
      }
      if (dialect !== 'posix' && /^-(?:Include|Exclude|Filter)$/i.test(tok)) {
        hasFilterOption = true;
      }
      continue;
    }
    targets.push(tok);
  }
  return { cmd, targets, hasFilterOption };
}

function deletesCurrentOrWildcardRelative(stmt: string): boolean {
  const parsed = parseDeleteStatement(stripOuterGroup(stmt), 'any');
  if (!parsed) return true;
  // 已经在 Temp 根里时，`find -delete` 等无显式目标的删除默认作用于当前目录（即 Temp 根）
  if (parsed.targets.length === 0) return true;
  return parsed.targets.some((target) => {
    // 含变量/命令替换/波浪号（如 $(ls)、$PWD/*、~+/*）都可能解析回当前 Temp 根，保守拦截
    if (/[$`%~()]/.test(target)) return true;
    // 明确的纯字面绝对路径（如 /var/log/a.txt 或 C:\foo）不依赖当前 Temp 根 cwd
    if (/^(?:[\\/]|[A-Za-z]:[\\/])/.test(target)) return false;
    const trimmed = target.replace(/^[.][\\/]+/, '');
    if (target === '.' || target === '..' || trimmed === '' || trimmed === '.') return true;
    const parts = trimmed.split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0) return true;
    if (parts.some((p) => p === '..')) return true;
    return /[*?[\]{}]/.test(parts[0]);
  });
}

const SSH_OPTS_WITH_ARG = new Set('BbcDEeFIiJLlmOopQRSWw');
const POSIX_SHELL_CMD = /^(?:\S*\/)?(?:sh|bash|zsh|dash|ksh)$/;
const MAX_NESTED_SCRIPT_DEPTH = 3;

/** ssh 的远端命令或 sh -c 的脚本：拆出来按独立脚本判定，不让同段脚本里别的命令的路径算到 rm 头上 */
function nestedScriptOf(stmt: string): { script: string; remote: boolean } | null {
  const tokens = tokenizeShell(stmt);
  if (!tokens) return null;
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const cmd = tokens[i++];
  if (cmd === undefined) return null;
  if (/^(?:\S*\/)?ssh$/.test(cmd)) {
    for (; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === '--') {
        i++;
        break;
      }
      if (!tok.startsWith('-') || tok === '-') break;
      for (let j = 1; j < tok.length; j++) {
        if (!SSH_OPTS_WITH_ARG.has(tok[j])) continue;
        if (j === tok.length - 1) i++;
        break;
      }
    }
    if (i >= tokens.length) return null;
    // 远端 shell 会把 host 之后的参数用空格拼起来重新解析
    return { script: tokens.slice(i + 1).join(' '), remote: true };
  }
  if (!POSIX_SHELL_CMD.test(cmd)) return null;
  let sawC = false;
  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith('-') || tok === '-' || tok === '--') break;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(tok)) sawC = true;
    else if (tok === '-o' || tok === '+o') i++;
  }
  if (tokens[i] === '--') i++;
  // 脚本后还有位置参数（sh -c 'rm -rf "$1"' _ /tmp）时路径在外层，退回整句判定
  return sawC && i === tokens.length - 1 ? { script: tokens[i], remote: false } : null;
}

const REMOTE_TEMP_ROOT_MATCHER = buildTempRootMatcher(null);

function scanTempRootDeletes(
  command: string,
  matcher: TempRootMatcher,
  startInTempRoot: boolean,
  depth: number
): boolean {
  const cleaned = stripShellComments(stripNonShellHeredocs(command));
  const statements = splitShellStatements(cleaned);
  const { rootRef, exactRoot } = matcher;
  let inTempRoot = startInTempRoot;
  for (const stmt of statements) {
    const nested = depth < MAX_NESTED_SCRIPT_DEPTH ? nestedScriptOf(stmt) : null;
    if (nested) {
      // 远端路径属于远端机器：按 POSIX 共享 Temp 根判，不套本机 Temp 路径与本机 cwd
      const hit = nested.remote
        ? scanTempRootDeletes(nested.script, REMOTE_TEMP_ROOT_MATCHER, false, depth + 1)
        : scanTempRootDeletes(nested.script, matcher, inTempRoot, depth + 1);
      if (hit) return true;
      continue;
    }
    if (DELETE_VERB.test(stmt)) {
      if (rootRef.test(stmt)) return true;
      if (inTempRoot && deletesCurrentOrWildcardRelative(stmt)) return true;
    }
    const target = cdTargetOf(stmt);
    if (target !== null) {
      inTempRoot = exactRoot.test(target);
    }
  }
  return false;
}

/** 命令里有删除动作且作用于系统 Temp 根：按语句判定，不跨无关命令误拼，也不吞掉 cd /tmp && rm -rf * */
export function deletesTempRoot(command: string, opts?: { tmpDir?: string }): boolean {
  return scanTempRootDeletes(command, buildTempRootMatcher(opts?.tmpDir), false, 0);
}

const TEMP_SUBPATH_GENERAL_RULES: ReadonlySet<string> = new Set([
  'core.filesystem:rm-rf-general',
  'core.filesystem:rm-r-f-separate',
  'core.filesystem:rm-recursive-force-long',
  'core.filesystem:rm-recursive-general',
  'core.filesystem:unlink-general',
  'core.filesystem:powershell-remove-item-recursive',
]);
/** macOS os.tmpdir() 下会话专属目录可能触发 root-home 规则：绝不开放通用 /tmp 豁免，只允许精确命中会话专属目录 */
const SESSION_TEMP_ONLY_RULES: ReadonlySet<string> = new Set([
  'core.filesystem:rm-rf-root-home',
  'core.filesystem:rm-r-f-separate-root-home',
  'core.filesystem:rm-recursive-force-root-home',
]);

export type TempSubpathExemptScope = 'temp-subpath' | 'session-only';

export const isTempSubpathExemptibleHit = (hit: CommandGuardHit): TempSubpathExemptScope | null => {
  if (hit.decision !== undefined && hit.decision !== 'deny') return null;
  if (TEMP_SUBPATH_GENERAL_RULES.has(hit.ruleId)) return 'temp-subpath';
  if (SESSION_TEMP_ONLY_RULES.has(hit.ruleId)) return 'session-only';
  return null;
};

const POSIX_DELETE_CMDS = new Set(['rm', 'rmdir', 'unlink']);
const PS_DELETE_CMDS = new Set(['remove-item', 'ri', 'rd', 'del', 'erase']);

export interface SafeTempStripOptions {
  tmpDir?: string;
  envTmpDir?: string;
  sessionTempDir?: string | null;
  /** true 时仅允许会话专属临时目录本身或其纯字面子路径（用于 root-home 规则收紧） */
  sessionOnly?: boolean;
}

function matchTempPrefix(
  target: string,
  dialect: 'posix' | 'ps',
  opts?: SafeTempStripOptions
): { rest: string; exactOwned?: boolean } | null {
  const sessionDir = opts?.sessionTempDir?.trim().replace(/[\\/]+$/, '');
  if (sessionDir && path.isAbsolute(sessionDir)) {
    const normSession = sessionDir.replace(/\\/g, '/');
    const normTarget = target.replace(/\\/g, '/').replace(/\/+$/, '');
    const fold = dialect === 'ps' || process.platform !== 'linux';
    const a = fold ? normTarget.toLowerCase() : normTarget;
    const b = fold ? normSession.toLowerCase() : normSession;
    if (a === b) return { rest: '', exactOwned: true };
    if (a.startsWith(`${b}/`)) return { rest: normTarget.slice(normSession.length + 1) };
  }
  if (opts?.sessionOnly) return null;

  const prefixPatterns: RegExp[] = [];
  if (dialect === 'posix') {
    prefixPatterns.push(/^\/(?:private\/)?(?:var\/)?tmp\//);
    // 只有当前进程环境里 TMPDIR 非空且是合法绝对路径时，才允许 $TMPDIR/<subpath>（防 Linux 空 TMPDIR 退化成 /<subpath>）
    const envTmp = normalizedTmpDir(opts?.envTmpDir ?? process.env.TMPDIR ?? '');
    if (envTmp) {
      prefixPatterns.push(/^\$(?:TMPDIR|\{TMPDIR\})\//);
    }
  } else {
    prefixPatterns.push(
      /^(?:\$env:(?:TEMP|TMP)|\$\{env:(?:TEMP|TMP)\}|%(?:TEMP|TMP)%)[\\/]/i,
      /^(?:\$env:LOCALAPPDATA|\$\{env:LOCALAPPDATA\}|%LOCALAPPDATA%)[\\/]+Temp[\\/]/i
    );
  }

  const runtimeTmp = normalizedTmpDir(opts?.tmpDir);
  if (runtimeTmp) {
    const escaped = escapeRegExp(runtimeTmp).replace(/(?:\\\/|\\\\)+/g, '[\\\\/]');
    prefixPatterns.push(new RegExp(`^${escaped}[\\\\/]`, dialect === 'ps' ? 'i' : ''));
  }

  for (const re of prefixPatterns) {
    const m = re.exec(target);
    if (m) return { rest: target.slice(m[0].length) };
  }
  return null;
}

function isSafeTempSubpath(
  target: string,
  dialect: 'posix' | 'ps',
  opts?: SafeTempStripOptions
): boolean {
  if (!target) return false;
  const matched = matchTempPrefix(target, dialect, opts);
  if (!matched) return false;
  if (matched.exactOwned) return true;
  const rest = matched.rest.replace(/[\\/]+$/, '');
  if (!rest) return false;
  // 严禁任何通配符、花括号展开、逗号数组、变量/命令替换与波浪号：只放行纯字面具体子路径
  if (UNSAFE_SUBPATH_META.test(rest)) return false;
  const segments = rest.split(/[\\/]+/);
  if (segments.length === 0) return false;
  if (segments.some((seg) => seg === '' || seg === '.' || seg.includes('..'))) return false;
  return true;
}

function isPureSafeTempDeleteStatement(
  stmt: string,
  dialect: 'posix' | 'ps',
  opts?: SafeTempStripOptions
): boolean {
  // 管道、后台 &、重定向、命令替换、子 shell 一律保守不放行
  if (/[|&<>`()]|\$\(/.test(stmt)) return false;
  const parsed = parseDeleteStatement(stmt, dialect);
  if (!parsed || parsed.hasFilterOption || parsed.targets.length === 0) return false;
  if (dialect === 'posix' && !POSIX_DELETE_CMDS.has(parsed.cmd)) return false;
  if (dialect === 'ps' && !PS_DELETE_CMDS.has(parsed.cmd.toLowerCase())) return false;
  return parsed.targets.every((target) => isSafeTempSubpath(target, dialect, opts));
}

/**
 * 完全放行模式下，从命令中剥离已严格验证的「明确临时子目录/文件删除」语句：
 * - 若任何删除语句不是明确临时子路径（或命中 Temp 根删除），整体返回 null（照常拦截）；
 * - 含 heredoc、修改临时目录环境变量或创建符号链接时保守返回 null（防止剥离丢内容或路径劫持）；
 * - 若全部删除语句都安全，返回其余非删除语句原文 `remaining` 供守卫复检。
 */
export function stripSafeTempSubpathDeletes(
  tool: string,
  command: string,
  opts?: SafeTempStripOptions
): { remaining: string } | null {
  const dialect = dcgDialect(tool);
  if (!dialect || deletesTempRoot(command, opts)) return null;
  if (command.split(/\r?\n/).some((line) => findUnquotedHeredoc(line) !== null)) return null;
  if (TEMP_ENV_MUTATION.test(command) || SYMLINK_CREATION.test(command)) return null;
  const statements = splitShellStatements(command);
  const remaining: string[] = [];
  let stripped = 0;
  for (const stmt of statements) {
    if (!DELETE_VERB.test(stmt)) {
      remaining.push(stmt);
      continue;
    }
    if (!isPureSafeTempDeleteStatement(stmt, dialect, opts)) return null;
    stripped++;
  }
  if (stripped === 0) return null;
  return { remaining: remaining.join('\n') };
}

/** 内置 Temp 根删除规则先于 dcg 判定；未安装 dcg 时同样生效 */
export function withTempRootGuard(inner: CommandGuard | undefined): CommandGuard {
  return (tool, command, signal, options) => {
    if (dcgDialect(tool) && deletesTempRoot(command)) {
      return Promise.resolve({ ruleId: TEMP_ROOT_RULE_ID, reason: TEMP_ROOT_REASON });
    }
    return inner ? inner(tool, command, signal, options) : Promise.resolve(null);
  };
}

const DCG_RECHECK_UNAVAILABLE_REASON =
  'Command guard could not finish rechecking the remaining command; confirm before running.';

export function createDcgGuard(
  binaryPath: string,
  timeoutMs = 1500,
  extraPacks: readonly string[] = []
): CommandGuard {
  return (tool, command, signal, options) => {
    const dialect = dcgDialect(tool);
    const failClosed = options?.failClosedOnError === true;
    const errorResult = (): CommandGuardHit | null =>
      failClosed
        ? {
            ruleId: DCG_INVALID_VERDICT_RULE_ID,
            reason: DCG_RECHECK_UNAVAILABLE_REASON,
            decision: 'ask',
          }
        : null;
    if (!dialect || !command.trim()) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve(errorResult());
    return new Promise((resolve) => {
      let stdout = '';
      let settled = false;
      const argv = ['--robot', 'test', '--dialect', dialect];
      // --with-packs 只能由 0.17.2+ 二进制识别；版本门控在 Main 侧下发前完成
      if (extraPacks.length > 0) argv.push('--with-packs', extraPacks.join(','));
      argv.push(command);
      const child = spawn(binaryPath, argv, {
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
        finish(errorResult());
      };
      const timer = setTimeout(onAbort, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(0, MAX_OUTPUT);
      });
      child.on('error', () => finish(errorResult()));
      child.on('close', (code) =>
        finish(code === null ? errorResult() : parseDcgVerdict(code, stdout))
      );
    });
  };
}
