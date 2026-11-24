const MAX_TEXT = 500;
const MAX_PATH = 1024;
const MAX_ITEMS = 20;

const SHA_RE = /^[0-9a-fA-F]{7,40}$/;
const REPO_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

const PR_STATES = ['merged', 'open', 'closed'] as const;
const CHECK_GRADES = ['pass', 'fail', 'skipped'] as const;
const CHECK_KINDS = ['pr-state', 'pr-squash', 'pr-branch', 'commit', 'screenshot', 'ci'] as const;
const CHECK_STATUSES = ['verified', 'mismatch', 'unverifiable'] as const;

export type GoalPrState = (typeof PR_STATES)[number];
export type GoalCheckGrade = (typeof CHECK_GRADES)[number];

export interface GoalPull {
  repo: string;
  number: number;
  state?: GoalPrState;
  squashSha?: string;
  remoteBranchDeleted?: boolean;
}

export interface GoalResult {
  summary?: string;
  prs?: GoalPull[];
  commits?: string[];
  checks?: {
    typecheck?: GoalCheckGrade;
    lint?: GoalCheckGrade;
    tests?: {
      passed?: number;
      failed?: number;
      failuresUnrelated?: boolean;
      note?: string;
    };
    ci?: { runId?: number; conclusion?: string; repo?: string };
  };
  screenshots?: { path: string; caption?: string }[];
  followUps?: string[];
  needsUser?: string[];
  deploy?: { needed?: boolean; phone?: boolean; relay?: boolean; note?: string };
  worktree?: { path?: string; branch?: string };
}

export type GoalResultCheckStatus = (typeof CHECK_STATUSES)[number];
export type GoalResultCheckKind = (typeof CHECK_KINDS)[number];

export interface GoalResultCheck {
  kind: GoalResultCheckKind;
  ref: string;
  status: GoalResultCheckStatus;
  detail?: string;
}

/** 用户对某条 needsUser 的答复；index 是 needsUserItems 里的位置 */
export interface NeedsUserAnswer {
  index: number;
  answer: string;
  at: number;
}

/** 秘书把某条 needsUser 升级给用户；text 是改写后给用户看的一句话，缺省用原文 */
export interface NeedsUserEscalation {
  index: number;
  text?: string;
  at: number;
}

export interface GoalResultView {
  result: GoalResult;
  checks?: GoalResultCheck[];
  /** 秘书带关联转问后用户的答复；属于这一份结果，新结果整体替换时自然清空 */
  answers?: NeedsUserAnswer[];
  /** 秘书筛选后升级给用户的条目；同样随新结果整体替换 */
  escalations?: NeedsUserEscalation[];
  at: number;
}

function listNeedsUser(result: GoalResult): string[] {
  return (result.needsUser ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
}

/** 结构化结果里是否明确列出了需要用户亲自处理的事项 */
export function needsUserItems(view: GoalResultView | undefined): string[] {
  return view ? listNeedsUser(view.result) : [];
}

export function hasNeedsUser(view: GoalResultView | undefined): boolean {
  return needsUserItems(view).length > 0;
}

/** 记下一次答复：index 缺省表示覆盖全部条目，同一条再答以新的为准 */
export function answerGoalResultNeedsUser(
  view: GoalResultView,
  index: number | undefined,
  answer: string,
  at: number
): GoalResultView {
  const count = needsUserItems(view).length;
  const targets = index === undefined ? [...Array(count).keys()] : [index];
  const kept = (view.answers ?? []).filter((item) => !targets.includes(item.index));
  const added = targets.map((target) => ({ index: target, answer, at }));
  return { ...view, answers: [...kept, ...added].sort((a, b) => a.index - b.index) };
}

export function unansweredNeedsUserCount(view: GoalResultView | undefined): number {
  const answered = new Set((view?.answers ?? []).map((item) => item.index));
  return needsUserItems(view).filter((_, index) => !answered.has(index)).length;
}

/** 秘书没在这段时间里升级或处理，needsUser 照旧直接给用户 */
export const NEEDS_USER_TRIAGE_MS = 30 * 60_000;

/** 秘书筛选的截止时间：从完成或秘书最后一次升级、用户最后一次答复算起 */
export function needsUserTriageDeadline(view: GoalResultView): number {
  const touched = [...(view.escalations ?? []), ...(view.answers ?? [])].map((item) => item.at);
  return Math.max(view.at, ...touched) + NEEDS_USER_TRIAGE_MS;
}

/** 记下一次升级：index 缺省表示全部条目（保留原文），同一条再升级以新的为准 */
export function escalateGoalResultNeedsUser(
  view: GoalResultView,
  index: number | undefined,
  text: string | undefined,
  at: number
): GoalResultView {
  const count = needsUserItems(view).length;
  const targets = index === undefined ? [...Array(count).keys()] : [index];
  const kept = (view.escalations ?? []).filter((item) => !targets.includes(item.index));
  const added = targets.map((target) => ({
    index: target,
    ...(index !== undefined && text ? { text } : {}),
    at,
  }));
  return { ...view, escalations: [...kept, ...added].sort((a, b) => a.index - b.index) };
}

export interface ShownNeedsUser {
  /** 此刻还在等秘书筛选：不进「需要你」 */
  triaging: boolean;
  /** 给用户看的条目，升级过的用改写后的文字 */
  items: string[];
  /** 答复按 items 里的位置重新编号 */
  answers: NeedsUserAnswer[];
}

/**
 * 用户此刻该看到哪些 needsUser。triage 表示这份结果先经秘书（派出或跟踪、秘书会话还在）。
 * 有升级了还没答的条目，只给升级的；升级的都答完（或没升级过）而还剩没处理的条目，
 * 截止前回到秘书手里，超时全部给用户；不经秘书的全部照旧给用户。
 */
export function shownNeedsUser(
  view: GoalResultView | undefined,
  triage: boolean,
  now: number
): ShownNeedsUser {
  const all = needsUserItems(view);
  if (!view || all.length === 0) return { triaging: false, items: [], answers: [] };
  const escalated = new Map(
    (view.escalations ?? [])
      .filter((item) => item.index < all.length)
      .map((item) => [item.index, item.text])
  );
  const answered = new Set((view.answers ?? []).map((item) => item.index));
  const awaiting = [...escalated.keys()].some((index) => !answered.has(index));
  const untouched = all.some((_, index) => !escalated.has(index) && !answered.has(index));
  if (triage && !awaiting && untouched && now < needsUserTriageDeadline(view))
    return { triaging: true, items: [], answers: [] };
  const indexes =
    triage && (awaiting || !untouched)
      ? [...escalated.keys()].sort((a, b) => a - b)
      : [...all.keys()];
  const position = new Map(indexes.map((index, at) => [index, at]));
  return {
    triaging: false,
    items: indexes.map((index) => escalated.get(index) || all[index]),
    answers: (view.answers ?? []).flatMap((answer) => {
      const at = position.get(answer.index);
      return at === undefined ? [] : [{ ...answer, index: at }];
    }),
  };
}

/** 清除已处理的 needsUser 与答复，保留 PR/commit/checks 等客观事实；无剩余内容时返回 undefined */
export function stripGoalResultNeedsUser(
  view: GoalResultView | undefined
): GoalResultView | undefined {
  if (!view?.result.needsUser && !view?.answers && !view?.escalations) return view;
  const { needsUser: _needsUser, ...rest } = view.result;
  const { answers: _answers, escalations: _escalations, ...base } = view;
  const hasRest = Object.keys(rest).length > 0 || (view.checks?.length ?? 0) > 0;
  if (!hasRest) return undefined;
  return { ...base, result: rest };
}

export type GoalResultParse = { ok: true; value: GoalResult } | { ok: false; error: string };

type Fail = { ok: false; error: string };
type Ok<T> = { ok: true; value: T };
type Parsed<T> = Ok<T> | Fail;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, reason: string): Fail {
  return { ok: false, error: `${path}: ${reason}` };
}

function rejectUnknown(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[]
): Fail | undefined {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return fail(path ? `${path}.${key}` : key, '未知字段');
  }
  return undefined;
}

function takeString(value: unknown, path: string, max: number): Parsed<string> {
  if (typeof value !== 'string') return fail(path, '必须是字符串');
  if (value.length > max) return fail(path, `不能超过 ${max} 个字符`);
  return { ok: true, value };
}

function takeSha(value: unknown, path: string): Parsed<string> {
  const text = takeString(value, path, 40);
  if (!text.ok) return text;
  if (!SHA_RE.test(text.value)) return fail(path, '必须是 7 到 40 位十六进制');
  return { ok: true, value: text.value.toLowerCase() };
}

function takeRepo(value: unknown, path: string): Parsed<string> {
  const text = takeString(value, path, MAX_TEXT);
  if (!text.ok) return text;
  if (!REPO_RE.test(text.value)) return fail(path, '必须是 owner/name');
  return text;
}

function takeInt(value: unknown, path: string, min: number): Parsed<number> {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fail(path, '必须是整数');
  if (value < min) return fail(path, min > 0 ? '必须是正整数' : '不能为负');
  return { ok: true, value };
}

function takeBool(value: unknown, path: string): Parsed<boolean> {
  if (typeof value !== 'boolean') return fail(path, '必须是布尔值');
  return { ok: true, value };
}

function takeState(value: unknown, path: string): Parsed<GoalPrState> {
  if (value === 'merged' || value === 'open' || value === 'closed') return { ok: true, value };
  return fail(path, '必须是 merged、open 或 closed');
}

function takeGrade(value: unknown, path: string): Parsed<GoalCheckGrade> {
  if (value === 'pass' || value === 'fail' || value === 'skipped') return { ok: true, value };
  return fail(path, '必须是 pass、fail 或 skipped');
}

function takeArray(value: unknown, path: string): Parsed<unknown[]> {
  if (!Array.isArray(value)) return fail(path, '必须是数组');
  if (value.length > MAX_ITEMS) return fail(path, `最多 ${MAX_ITEMS} 项`);
  return { ok: true, value };
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value);
}

function parsePr(raw: unknown, path: string): Parsed<GoalPull> {
  if (!isRecord(raw)) return fail(path, '必须是对象');
  const unknownKey = rejectUnknown(raw, path, [
    'repo',
    'number',
    'state',
    'squashSha',
    'remoteBranchDeleted',
  ]);
  if (unknownKey) return unknownKey;
  if (!('repo' in raw)) return fail(`${path}.repo`, '缺少字段');
  if (!('number' in raw)) return fail(`${path}.number`, '缺少字段');
  const repo = takeRepo(raw.repo, `${path}.repo`);
  if (!repo.ok) return repo;
  const number = takeInt(raw.number, `${path}.number`, 1);
  if (!number.ok) return number;
  const pr: GoalPull = { repo: repo.value, number: number.value };
  if ('state' in raw) {
    const state = takeState(raw.state, `${path}.state`);
    if (!state.ok) return state;
    pr.state = state.value;
  }
  if ('squashSha' in raw) {
    const sha = takeSha(raw.squashSha, `${path}.squashSha`);
    if (!sha.ok) return sha;
    pr.squashSha = sha.value;
  }
  if ('remoteBranchDeleted' in raw) {
    const deleted = takeBool(raw.remoteBranchDeleted, `${path}.remoteBranchDeleted`);
    if (!deleted.ok) return deleted;
    pr.remoteBranchDeleted = deleted.value;
  }
  return { ok: true, value: pr };
}

function parsePrs(raw: unknown, path: string): Parsed<GoalPull[]> {
  const list = takeArray(raw, path);
  if (!list.ok) return list;
  const prs: GoalPull[] = [];
  for (let index = 0; index < list.value.length; index += 1) {
    const item = parsePr(list.value[index], `${path}.${index}`);
    if (!item.ok) return item;
    prs.push(item.value);
  }
  return { ok: true, value: prs };
}

function parseShas(raw: unknown, path: string): Parsed<string[]> {
  const list = takeArray(raw, path);
  if (!list.ok) return list;
  const shas: string[] = [];
  for (let index = 0; index < list.value.length; index += 1) {
    const sha = takeSha(list.value[index], `${path}.${index}`);
    if (!sha.ok) return sha;
    shas.push(sha.value);
  }
  return { ok: true, value: shas };
}

function parseStrings(raw: unknown, path: string): Parsed<string[]> {
  const list = takeArray(raw, path);
  if (!list.ok) return list;
  const texts: string[] = [];
  for (let index = 0; index < list.value.length; index += 1) {
    const text = takeString(list.value[index], `${path}.${index}`, MAX_TEXT);
    if (!text.ok) return text;
    texts.push(text.value);
  }
  return { ok: true, value: texts };
}

function parseTests(
  raw: unknown,
  path: string
): Parsed<NonNullable<GoalResult['checks']>['tests']> {
  if (!isRecord(raw)) return fail(path, '必须是对象');
  const unknownKey = rejectUnknown(raw, path, ['passed', 'failed', 'failuresUnrelated', 'note']);
  if (unknownKey) return unknownKey;
  const tests: NonNullable<NonNullable<GoalResult['checks']>['tests']> = {};
  if ('passed' in raw) {
    const passed = takeInt(raw.passed, `${path}.passed`, 0);
    if (!passed.ok) return passed;
    tests.passed = passed.value;
  }
  if ('failed' in raw) {
    const failed = takeInt(raw.failed, `${path}.failed`, 0);
    if (!failed.ok) return failed;
    tests.failed = failed.value;
  }
  if ('failuresUnrelated' in raw) {
    const flag = takeBool(raw.failuresUnrelated, `${path}.failuresUnrelated`);
    if (!flag.ok) return flag;
    tests.failuresUnrelated = flag.value;
  }
  if ('note' in raw) {
    const note = takeString(raw.note, `${path}.note`, MAX_TEXT);
    if (!note.ok) return note;
    tests.note = note.value;
  }
  return { ok: true, value: tests };
}

function parseCi(raw: unknown, path: string): Parsed<NonNullable<GoalResult['checks']>['ci']> {
  if (!isRecord(raw)) return fail(path, '必须是对象');
  const unknownKey = rejectUnknown(raw, path, ['runId', 'conclusion', 'repo']);
  if (unknownKey) return unknownKey;
  const ci: NonNullable<NonNullable<GoalResult['checks']>['ci']> = {};
  if ('runId' in raw) {
    const runId = takeInt(raw.runId, `${path}.runId`, 1);
    if (!runId.ok) return runId;
    ci.runId = runId.value;
  }
  if ('conclusion' in raw) {
    const conclusion = takeString(raw.conclusion, `${path}.conclusion`, MAX_TEXT);
    if (!conclusion.ok) return conclusion;
    ci.conclusion = conclusion.value;
  }
  if ('repo' in raw) {
    const repo = takeRepo(raw.repo, `${path}.repo`);
    if (!repo.ok) return repo;
    ci.repo = repo.value;
  }
  return { ok: true, value: ci };
}

function parseChecks(raw: unknown, path: string): Parsed<GoalResult['checks']> {
  if (!isRecord(raw)) return fail(path, '必须是对象');
  const unknownKey = rejectUnknown(raw, path, ['typecheck', 'lint', 'tests', 'ci']);
  if (unknownKey) return unknownKey;
  const checks: NonNullable<GoalResult['checks']> = {};
  if ('typecheck' in raw) {
    const grade = takeGrade(raw.typecheck, `${path}.typecheck`);
    if (!grade.ok) return grade;
    checks.typecheck = grade.value;
  }
  if ('lint' in raw) {
    const grade = takeGrade(raw.lint, `${path}.lint`);
    if (!grade.ok) return grade;
    checks.lint = grade.value;
  }
  if ('tests' in raw) {
    const tests = parseTests(raw.tests, `${path}.tests`);
    if (!tests.ok) return tests;
    checks.tests = tests.value;
  }
  if ('ci' in raw) {
    const ci = parseCi(raw.ci, `${path}.ci`);
    if (!ci.ok) return ci;
    checks.ci = ci.value;
  }
  return { ok: true, value: checks };
}

function parseShot(raw: unknown, path: string): Parsed<{ path: string; caption?: string }> {
  if (!isRecord(raw)) return fail(path, '必须是对象');
  const unknownKey = rejectUnknown(raw, path, ['path', 'caption']);
  if (unknownKey) return unknownKey;
  if (!('path' in raw)) return fail(`${path}.path`, '缺少字段');
  const file = takeString(raw.path, `${path}.path`, MAX_PATH);
  if (!file.ok) return file;
  if (!isAbsolutePath(file.value)) return fail(`${path}.path`, '必须是绝对路径');
  const shot: { path: string; caption?: string } = { path: file.value };
  if ('caption' in raw) {
    const caption = takeString(raw.caption, `${path}.caption`, MAX_TEXT);
    if (!caption.ok) return caption;
    shot.caption = caption.value;
  }
  return { ok: true, value: shot };
}

function parseShots(raw: unknown, path: string): Parsed<{ path: string; caption?: string }[]> {
  const list = takeArray(raw, path);
  if (!list.ok) return list;
  const shots: { path: string; caption?: string }[] = [];
  for (let index = 0; index < list.value.length; index += 1) {
    const item = parseShot(list.value[index], `${path}.${index}`);
    if (!item.ok) return item;
    shots.push(item.value);
  }
  return { ok: true, value: shots };
}

function parseDeploy(raw: unknown, path: string): Parsed<GoalResult['deploy']> {
  if (!isRecord(raw)) return fail(path, '必须是对象');
  const unknownKey = rejectUnknown(raw, path, ['needed', 'phone', 'relay', 'note']);
  if (unknownKey) return unknownKey;
  const deploy: NonNullable<GoalResult['deploy']> = {};
  if ('needed' in raw) {
    const needed = takeBool(raw.needed, `${path}.needed`);
    if (!needed.ok) return needed;
    deploy.needed = needed.value;
  }
  if ('phone' in raw) {
    const phone = takeBool(raw.phone, `${path}.phone`);
    if (!phone.ok) return phone;
    deploy.phone = phone.value;
  }
  if ('relay' in raw) {
    const relay = takeBool(raw.relay, `${path}.relay`);
    if (!relay.ok) return relay;
    deploy.relay = relay.value;
  }
  if ('note' in raw) {
    const note = takeString(raw.note, `${path}.note`, MAX_TEXT);
    if (!note.ok) return note;
    deploy.note = note.value;
  }
  return { ok: true, value: deploy };
}

function parseWorktree(raw: unknown, path: string): Parsed<GoalResult['worktree']> {
  if (!isRecord(raw)) return fail(path, '必须是对象');
  const unknownKey = rejectUnknown(raw, path, ['path', 'branch']);
  if (unknownKey) return unknownKey;
  const worktree: NonNullable<GoalResult['worktree']> = {};
  if ('path' in raw) {
    const file = takeString(raw.path, `${path}.path`, MAX_PATH);
    if (!file.ok) return file;
    worktree.path = file.value;
  }
  if ('branch' in raw) {
    const branch = takeString(raw.branch, `${path}.branch`, MAX_TEXT);
    if (!branch.ok) return branch;
    worktree.branch = branch.value;
  }
  return { ok: true, value: worktree };
}

export function parseGoalResult(raw: unknown): GoalResultParse {
  if (!isRecord(raw)) return fail('result', '必须是对象');
  const unknownKey = rejectUnknown(raw, '', [
    'summary',
    'prs',
    'commits',
    'checks',
    'screenshots',
    'followUps',
    'needsUser',
    'deploy',
    'worktree',
  ]);
  if (unknownKey) return unknownKey;
  const result: GoalResult = {};
  if ('summary' in raw) {
    const summary = takeString(raw.summary, 'summary', MAX_TEXT);
    if (!summary.ok) return summary;
    result.summary = summary.value;
  }
  if ('prs' in raw) {
    const prs = parsePrs(raw.prs, 'prs');
    if (!prs.ok) return prs;
    result.prs = prs.value;
  }
  if ('commits' in raw) {
    const commits = parseShas(raw.commits, 'commits');
    if (!commits.ok) return commits;
    result.commits = commits.value;
  }
  if ('checks' in raw) {
    const checks = parseChecks(raw.checks, 'checks');
    if (!checks.ok) return checks;
    result.checks = checks.value;
  }
  if ('screenshots' in raw) {
    const shots = parseShots(raw.screenshots, 'screenshots');
    if (!shots.ok) return shots;
    result.screenshots = shots.value;
  }
  if ('followUps' in raw) {
    const followUps = parseStrings(raw.followUps, 'followUps');
    if (!followUps.ok) return followUps;
    result.followUps = followUps.value;
  }
  if ('needsUser' in raw) {
    const needsUser = parseStrings(raw.needsUser, 'needsUser');
    if (!needsUser.ok) return needsUser;
    result.needsUser = needsUser.value;
  }
  if ('deploy' in raw) {
    const deploy = parseDeploy(raw.deploy, 'deploy');
    if (!deploy.ok) return deploy;
    result.deploy = deploy.value;
  }
  if ('worktree' in raw) {
    const worktree = parseWorktree(raw.worktree, 'worktree');
    if (!worktree.ok) return worktree;
    result.worktree = worktree.value;
  }
  return { ok: true, value: result };
}

function parseCheck(raw: unknown): GoalResultCheck | undefined {
  if (!isRecord(raw)) return undefined;
  if (rejectUnknown(raw, '', ['kind', 'ref', 'status', 'detail'])) return undefined;
  const { kind, ref, status, detail } = raw;
  if (
    kind !== 'pr-state' &&
    kind !== 'pr-squash' &&
    kind !== 'pr-branch' &&
    kind !== 'commit' &&
    kind !== 'screenshot' &&
    kind !== 'ci'
  ) {
    return undefined;
  }
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_TEXT) return undefined;
  if (status !== 'verified' && status !== 'mismatch' && status !== 'unverifiable') return undefined;
  const check: GoalResultCheck = { kind, ref, status };
  if (detail !== undefined) {
    if (typeof detail !== 'string' || detail.length > MAX_TEXT) return undefined;
    if (detail) check.detail = detail;
  }
  return check;
}

export function parseGoalResultView(raw: unknown): GoalResultView | undefined {
  if (!isRecord(raw)) return undefined;
  const parsed = parseGoalResult(raw.result);
  if (!parsed.ok) return undefined;
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined;
  const view: GoalResultView = { result: parsed.value, at: raw.at };
  const answers = parseAnswers(raw.answers);
  if (answers.length > 0) view.answers = answers;
  const escalations = parseEscalations(raw.escalations);
  if (escalations.length > 0) view.escalations = escalations;
  if (!Array.isArray(raw.checks)) return view;
  const checks = raw.checks.flatMap((item) => {
    const check = parseCheck(item);
    return check ? [check] : [];
  });
  if (checks.length > 0) view.checks = checks;
  return view;
}

function parseAnswers(raw: unknown): NeedsUserAnswer[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ITEMS).flatMap((item) => {
    if (!isRecord(item)) return [];
    const { index, answer, at } = item;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return [];
    if (typeof answer !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return [];
    return [{ index, answer: answer.slice(0, MAX_TEXT), at }];
  });
}

function parseEscalations(raw: unknown): NeedsUserEscalation[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ITEMS).flatMap((item) => {
    if (!isRecord(item)) return [];
    const { index, text, at } = item;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return [];
    if (typeof at !== 'number' || !Number.isFinite(at)) return [];
    if (text !== undefined && typeof text !== 'string') return [];
    return [{ index, ...(text ? { text: text.slice(0, MAX_TEXT) } : {}), at }];
  });
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function findPull(result: GoalResult, ref: string): GoalPull | undefined {
  const hash = ref.lastIndexOf('#');
  if (hash <= 0) return undefined;
  const repo = ref.slice(0, hash);
  const number = Number(ref.slice(hash + 1));
  if (!Number.isInteger(number)) return undefined;
  return result.prs?.find((pr) => pr.repo === repo && pr.number === number);
}

function statusMark(status: GoalResultCheckStatus, detail?: string): string {
  if (status === 'verified') return '✓';
  if (status === 'mismatch') return detail ? `✗ ${detail}` : '✗';
  return '?';
}

function checkSegment(result: GoalResult, check: GoalResultCheck): string {
  const mark = statusMark(check.status, check.detail);
  const pr = findPull(result, check.ref);
  if (check.kind === 'pr-state') {
    return pr?.state ? `PR ${check.ref} ${pr.state} ${mark}` : `PR ${check.ref} ${mark}`;
  }
  if (check.kind === 'pr-squash') {
    const sha = pr?.squashSha ?? check.ref;
    return `squash ${shortSha(sha)} ${mark}`;
  }
  if (check.kind === 'pr-branch') {
    return `${pr?.remoteBranchDeleted === false ? '远端分支仍在' : '远端分支已删'} ${mark}`;
  }
  if (check.kind === 'commit') return `sha ${shortSha(check.ref)} 在 main ${mark}`;
  return `CI ${check.ref} ${mark}`;
}

export function formatGoalResultChecks(view: GoalResultView): string {
  const parts: string[] = [];
  const shots: GoalResultCheck[] = [];
  const flushShots = () => {
    if (shots.length === 0) return;
    const mismatch = shots.find((check) => check.status === 'mismatch');
    const unverifiable = shots.some((check) => check.status === 'unverifiable');
    const mark = mismatch
      ? statusMark('mismatch', shots.length === 1 ? mismatch.detail : undefined)
      : unverifiable
        ? '?'
        : '✓';
    parts.push(`截图 ${shots.length} 张 ${mark}`);
    shots.length = 0;
  };
  for (const check of view.checks ?? []) {
    if (check.kind === 'screenshot') {
      shots.push(check);
      continue;
    }
    flushShots();
    parts.push(checkSegment(view.result, check));
  }
  flushShots();
  return `核验：${parts.join(' · ')}`;
}

function joinLine(label: string, bits: string[]): string | undefined {
  return bits.length > 0 ? `${label} ${bits.join(' ')}` : undefined;
}

export function formatGoalResultClaims(result: GoalResult): string {
  const lines: string[] = [];
  if (result.summary) lines.push(result.summary);
  for (const pr of result.prs ?? []) {
    const bits = [`PR ${pr.repo}#${pr.number}`];
    if (pr.state) bits.push(pr.state);
    if (pr.squashSha) bits.push('squash', pr.squashSha);
    if (pr.remoteBranchDeleted) bits.push('远端分支已删');
    lines.push(bits.join(' '));
  }
  if (result.commits && result.commits.length > 0)
    lines.push(`commits ${result.commits.join(' ')}`);
  if (result.checks?.typecheck) lines.push(`typecheck ${result.checks.typecheck}`);
  if (result.checks?.lint) lines.push(`lint ${result.checks.lint}`);
  const tests = result.checks?.tests;
  if (tests) {
    const counts: string[] = [];
    if (tests.passed !== undefined) counts.push(`${tests.passed} passed`);
    if (tests.failed !== undefined) counts.push(`${tests.failed} failed`);
    if (counts.length > 0) lines.push(`tests ${counts.join(', ')}`);
    if (tests.note) lines.push(tests.note);
  }
  const ci = result.checks?.ci;
  if (ci) {
    const bits = [
      ci.runId !== undefined ? String(ci.runId) : '',
      ci.conclusion ?? '',
      ci.repo ?? '',
    ].filter(Boolean);
    if (bits.length > 0) lines.push(`CI ${bits.join(' ')}`);
  }
  for (const shot of result.screenshots ?? []) {
    lines.push(shot.caption ? `截图 ${shot.path} ${shot.caption}` : `截图 ${shot.path}`);
  }
  for (const item of result.followUps ?? []) lines.push(`follow-up: ${item}`);
  for (const [index, item] of listNeedsUser(result).entries())
    lines.push(`needs-user[${index}]: ${item}`);
  if (result.deploy) {
    const bits = [
      result.deploy.needed ? 'needed' : '',
      result.deploy.phone ? 'phone' : '',
      result.deploy.relay ? 'relay' : '',
      result.deploy.note ?? '',
    ].filter(Boolean);
    const line = joinLine('deploy', bits);
    if (line) lines.push(line);
  }
  if (result.worktree) {
    const bits = [result.worktree.branch ?? '', result.worktree.path ?? ''].filter(Boolean);
    const line = joinLine('worktree', bits);
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

const textSchema = (maxLength = MAX_TEXT) => ({ type: 'string', maxLength });
const shaSchema = {
  type: 'string',
  minLength: 7,
  maxLength: 40,
  pattern: '^[0-9a-fA-F]{7,40}$',
};
const repoSchema = {
  type: 'string',
  maxLength: MAX_TEXT,
  pattern: REPO_RE.source,
};

export const GOAL_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { ...textSchema(), description: 'One-line outcome, concrete evidence' },
    prs: {
      type: 'array',
      maxItems: MAX_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['repo', 'number'],
        properties: {
          repo: { ...repoSchema, description: 'GitHub owner/name' },
          number: { type: 'integer', minimum: 1, description: 'Pull request number' },
          state: { type: 'string', enum: [...PR_STATES] },
          squashSha: shaSchema,
          remoteBranchDeleted: { type: 'boolean' },
        },
      },
    },
    commits: {
      type: 'array',
      maxItems: MAX_ITEMS,
      items: shaSchema,
    },
    checks: {
      type: 'object',
      additionalProperties: false,
      properties: {
        typecheck: { type: 'string', enum: [...CHECK_GRADES] },
        lint: { type: 'string', enum: [...CHECK_GRADES] },
        tests: {
          type: 'object',
          additionalProperties: false,
          properties: {
            passed: { type: 'integer', minimum: 0 },
            failed: { type: 'integer', minimum: 0 },
            failuresUnrelated: { type: 'boolean' },
            note: textSchema(),
          },
        },
        ci: {
          type: 'object',
          additionalProperties: false,
          properties: {
            runId: { type: 'integer', minimum: 1 },
            conclusion: textSchema(),
            repo: repoSchema,
          },
        },
      },
    },
    screenshots: {
      type: 'array',
      maxItems: MAX_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { ...textSchema(MAX_PATH), description: 'Absolute path of a screenshot file' },
          caption: textSchema(),
        },
      },
    },
    followUps: {
      type: 'array',
      maxItems: MAX_ITEMS,
      items: textSchema(),
      description:
        'Optional cleanup, suggestions and notes for the secretary. Nobody is required to act on them.',
    },
    needsUser: {
      type: 'array',
      maxItems: MAX_ITEMS,
      items: textSchema(),
      description:
        'Only what the user must decide or do by hand; only the user can do it, not you or the secretary. ' +
        'One short imperative sentence per item naming the action, e.g. "Decide whether to publish tgclient 0.7.1" ' +
        'or "Delete /tmp/enso-relay-upload-59dc0c2 on server ali". Optional cleanup, suggestions and notes go in followUps. ' +
        'Do not write relay phrasing such as "waiting for the secretary to ask the user". Omit it when nothing needs the user.',
    },
    deploy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        needed: { type: 'boolean' },
        phone: { type: 'boolean' },
        relay: { type: 'boolean' },
        note: textSchema(),
      },
    },
    worktree: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: textSchema(MAX_PATH),
        branch: textSchema(),
      },
    },
  },
};
