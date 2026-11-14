import type { ModelRef, ThinkingLevel } from '../types/agent';
import { THINKING_LEVELS } from '../types/agent';
import type {
  DispatchDraft,
  DispatchRecord,
  ProposalStatus,
  SecretaryDispatchFile,
  SecretaryProfile,
  SecretaryProfileDraft,
  SecretaryProposal,
  SecretaryResultKind,
  SecretarySchedule,
  SecretaryTodo,
  SecretaryUpdate,
  TakeoverDraft,
} from '../types/secretary';
import { parseSecretaryToolDraft } from './customTools';
import { parseSecretarySkillDraft } from './skills';

const DEFAULT_AVATAR_COLOR = '#7c5cff';
export const MIN_RUNNING_DISPATCHES = 1;
export const MAX_RUNNING_DISPATCHES = 10;
const COLOR_RE = /^#[0-9a-f]{6}$/iu;
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/u;

const AUTONOMIES = ['ask-first', 'tell-after', 'full'] as const;
const WORKTREE_MODES = ['never', 'auto', 'always'] as const;
const REPLY_LANGUAGES = ['ui', 'zh', 'en'] as const;
const STYLES = ['concise', 'detailed'] as const;
const NOTIFY_MODES = ['needs-user', 'with-done', 'off'] as const;
const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'pending',
  'executing',
  'succeeded',
  'failed',
  'rejected',
  'expired',
];
export const RESULT_KINDS: readonly SecretaryResultKind[] = [
  'goal-complete',
  'goal-blocked',
  'turn-ended',
  'needs-user',
  'failed',
  'stalled',
  'interrupted',
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function time(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  const n = time(value);
  return n === undefined ? undefined : Math.floor(n);
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function texts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const item_ = text(item);
    if (item_ && !out.includes(item_)) out.push(item_);
  }
  return out;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function parseModel(value: unknown): ModelRef | undefined {
  if (!isObject(value)) return undefined;
  const providerId = text(value.providerId);
  const modelId = text(value.modelId);
  return providerId && modelId ? { providerId, modelId } : undefined;
}

function parseProfileModel(value: unknown): SecretaryProfile['model'] {
  const model = parseModel(value);
  if (!model || !isObject(value)) return undefined;
  return THINKING_LEVELS.includes(value.thinkingLevel as ThinkingLevel)
    ? { ...model, thinkingLevel: value.thinkingLevel as ThinkingLevel }
    : model;
}

function parseDispatchModel(value: unknown): SecretaryProfile['dispatchModel'] {
  if (!isObject(value)) return { mode: 'project' };
  if (value.mode === 'fixed') {
    const model = parseModel(value.model);
    if (model) return { mode: 'fixed', model };
  }
  if (value.mode === 'choose' && Array.isArray(value.candidates)) {
    const candidates = value.candidates
      .map(parseModel)
      .filter((model): model is ModelRef => model !== undefined);
    if (candidates.length > 0) return { mode: 'choose', candidates };
  }
  return { mode: 'project' };
}

/** 缺省字段按设计稿默认值补齐，未知键丢弃；非对象视为未完成初次设置 */
export function parseProfile(value: unknown): SecretaryProfile | null {
  if (!isObject(value)) return null;
  const avatar = isObject(value.avatar) ? value.avatar : {};
  const imageVersion = count(avatar.imageVersion);
  const profile: SecretaryProfile = {
    version: 1,
    name: text(value.name) ?? '秘书',
    avatar: {
      color:
        typeof avatar.color === 'string' && COLOR_RE.test(avatar.color)
          ? avatar.color
          : DEFAULT_AVATAR_COLOR,
      ...(imageVersion && imageVersion > 0 ? { imageVersion } : {}),
    },
    autonomy: oneOf(value.autonomy, AUTONOMIES, 'ask-first'),
    autoApproveProjectIds: texts(value.autoApproveProjectIds),
    pluginIds: texts(value.pluginIds),
    skillIds: texts(value.skillIds),
    visibleProjectIds: Array.isArray(value.visibleProjectIds)
      ? texts(value.visibleProjectIds)
      : 'all',
    dispatchModel: parseDispatchModel(value.dispatchModel),
    dispatchWorktree: oneOf(value.dispatchWorktree, WORKTREE_MODES, 'auto'),
    maxRunningDispatches:
      clampInt(value.maxRunningDispatches, MIN_RUNNING_DISPATCHES, MAX_RUNNING_DISPATCHES) ?? 3,
    replyLanguage: oneOf(value.replyLanguage, REPLY_LANGUAGES, 'ui'),
    style: oneOf(value.style, STYLES, 'concise'),
    notify: oneOf(value.notify, NOTIFY_MODES, 'needs-user'),
    updatedAt: time(value.updatedAt) ?? 0,
  };
  const model = parseProfileModel(value.model);
  if (model) profile.model = model;
  const addressAs = text(value.addressAs);
  if (addressAs) profile.addressAs = addressAs;
  if (typeof value.dailyBriefAt === 'string' && CLOCK_RE.test(value.dailyBriefAt))
    profile.dailyBriefAt = value.dailyBriefAt;
  return profile;
}

export type ProfileDraftResult =
  | { ok: true; draft: SecretaryProfileDraft }
  | { ok: false; error: string };

const DRAFT_ENUMS: Record<string, readonly string[]> = {
  autonomy: AUTONOMIES,
  dispatchWorktree: WORKTREE_MODES,
  replyLanguage: REPLY_LANGUAGES,
  style: STYLES,
  notify: NOTIFY_MODES,
};

const PERSONA_MAX_CHARS = 4000;

function validModel(value: unknown): boolean {
  if (!isObject(value) || !text(value.providerId) || !text(value.modelId)) return false;
  return (
    value.thinkingLevel === undefined ||
    THINKING_LEVELS.includes(value.thinkingLevel as ThinkingLevel)
  );
}

function validDispatchModel(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.mode === 'project') return true;
  if (value.mode === 'fixed') return validModel(value.model);
  if (value.mode === 'choose') {
    return (
      Array.isArray(value.candidates) &&
      value.candidates.length > 0 &&
      value.candidates.every(validModel)
    );
  }
  return false;
}

function validIdList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => text(item) !== undefined);
}

/**
 * 表单与配置提案的写入收窄：越界的枚举当场拒绝，而不是像读盘那样静默回默认值，
 * 否则用户勾了"完全自主"却悄悄退回"先问我"。
 */
export function parseProfileDraft(value: unknown): ProfileDraftResult {
  if (!isObject(value)) return { ok: false, error: 'invalid profile' };
  for (const [key, allowed] of Object.entries(DRAFT_ENUMS)) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || !allowed.includes(raw)) {
      return { ok: false, error: `invalid ${key}` };
    }
  }
  const draft: SecretaryProfileDraft = {};
  const name = value.name === undefined ? undefined : text(value.name);
  if (value.name !== undefined && !name) return { ok: false, error: 'invalid name' };
  if (name) draft.name = name;
  if (value.avatar !== undefined) {
    if (!isObject(value.avatar)) return { ok: false, error: 'invalid avatar' };
    const color = value.avatar.color;
    if (color !== undefined && !(typeof color === 'string' && COLOR_RE.test(color))) {
      return { ok: false, error: 'invalid avatar' };
    }
    const imageVersion = value.avatar.imageVersion;
    if (
      imageVersion !== undefined &&
      !(typeof imageVersion === 'number' && Number.isInteger(imageVersion) && imageVersion >= 0)
    ) {
      return { ok: false, error: 'invalid avatar' };
    }
    draft.avatar = {
      ...(typeof color === 'string' ? { color } : {}),
      ...(typeof imageVersion === 'number' ? { imageVersion } : {}),
    };
  }
  if (value.model !== undefined) {
    if (value.model === null) draft.model = null;
    else if (validModel(value.model)) draft.model = parseProfileModel(value.model);
    else return { ok: false, error: 'invalid model' };
  }
  if (value.dispatchModel !== undefined) {
    if (!validDispatchModel(value.dispatchModel)) {
      return { ok: false, error: 'invalid dispatchModel' };
    }
    draft.dispatchModel = parseDispatchModel(value.dispatchModel);
  }
  if (value.autoApproveProjectIds !== undefined) {
    if (!validIdList(value.autoApproveProjectIds)) {
      return { ok: false, error: 'invalid autoApproveProjectIds' };
    }
    draft.autoApproveProjectIds = texts(value.autoApproveProjectIds);
  }
  if (value.pluginIds !== undefined) {
    if (!validIdList(value.pluginIds)) return { ok: false, error: 'invalid pluginIds' };
    draft.pluginIds = texts(value.pluginIds);
  }
  if (value.skillIds !== undefined) {
    if (!validIdList(value.skillIds)) return { ok: false, error: 'invalid skillIds' };
    draft.skillIds = texts(value.skillIds);
  }
  if (value.visibleProjectIds !== undefined) {
    if (value.visibleProjectIds !== 'all' && !validIdList(value.visibleProjectIds)) {
      return { ok: false, error: 'invalid visibleProjectIds' };
    }
    draft.visibleProjectIds =
      value.visibleProjectIds === 'all' ? 'all' : texts(value.visibleProjectIds);
  }
  if (value.maxRunningDispatches !== undefined) {
    const max = value.maxRunningDispatches;
    if (
      typeof max !== 'number' ||
      !Number.isInteger(max) ||
      max < MIN_RUNNING_DISPATCHES ||
      max > MAX_RUNNING_DISPATCHES
    ) {
      return { ok: false, error: 'invalid maxRunningDispatches' };
    }
    draft.maxRunningDispatches = max;
  }
  if (value.addressAs !== undefined) {
    if (value.addressAs === null) draft.addressAs = null;
    else if (text(value.addressAs)) draft.addressAs = text(value.addressAs) as string;
    else return { ok: false, error: 'invalid addressAs' };
  }
  if (value.dailyBriefAt !== undefined) {
    if (value.dailyBriefAt === null) draft.dailyBriefAt = null;
    else if (typeof value.dailyBriefAt === 'string' && CLOCK_RE.test(value.dailyBriefAt)) {
      draft.dailyBriefAt = value.dailyBriefAt;
    } else return { ok: false, error: 'invalid dailyBriefAt' };
  }
  if (value.autonomy !== undefined) draft.autonomy = value.autonomy as SecretaryProfile['autonomy'];
  if (value.dispatchWorktree !== undefined) {
    draft.dispatchWorktree = value.dispatchWorktree as SecretaryProfile['dispatchWorktree'];
  }
  if (value.replyLanguage !== undefined) {
    draft.replyLanguage = value.replyLanguage as SecretaryProfile['replyLanguage'];
  }
  if (value.style !== undefined) draft.style = value.style as SecretaryProfile['style'];
  if (value.notify !== undefined) draft.notify = value.notify as SecretaryProfile['notify'];
  if (value.persona !== undefined) {
    if (typeof value.persona !== 'string' || value.persona.length > PERSONA_MAX_CHARS) {
      return { ok: false, error: 'invalid persona' };
    }
    draft.persona = value.persona.trim();
  }
  return { ok: true, draft };
}

function parseDraft(value: unknown): DispatchDraft | undefined {
  if (!isObject(value)) return undefined;
  const projectId = text(value.projectId);
  const prompt = text(value.prompt);
  if (!projectId || !prompt) return undefined;
  const draft: DispatchDraft = { projectId, prompt, worktree: value.worktree === true };
  const title = text(value.title);
  if (title) draft.title = title;
  const goal = text(value.goal);
  if (goal) draft.goal = goal;
  const model = parseModel(value.model);
  if (model) draft.model = model;
  const todoId = text(value.todoId);
  if (todoId) draft.todoId = todoId;
  return draft;
}

function parseProposal(value: unknown): SecretaryProposal | undefined {
  if (!isObject(value)) return undefined;
  const id = text(value.id);
  const secretaryConversationId = text(value.secretaryConversationId);
  const createdAt = time(value.createdAt);
  const updatedAt = time(value.updatedAt);
  if (!id || !secretaryConversationId || createdAt === undefined || updatedAt === undefined)
    return undefined;
  if (!PROPOSAL_STATUSES.includes(value.status as ProposalStatus)) return undefined;
  const base = {
    id,
    secretaryConversationId,
    createdAt,
    updatedAt,
    status: value.status as ProposalStatus,
  };
  const error = text(value.error);
  if (value.kind === 'dispatch') {
    const draft = parseDraft(value.draft);
    if (!draft) return undefined;
    const conversationId = text(value.conversationId);
    return {
      ...base,
      kind: 'dispatch',
      draft,
      ...(conversationId ? { conversationId } : {}),
      ...(error ? { error } : {}),
    };
  }
  if (value.kind === 'profile') {
    // 草案字段在确认写入时再经 parseProfile 归一，这里只保证是对象
    if (!isObject(value.draft)) return undefined;
    return { ...base, kind: 'profile', draft: { ...value.draft }, ...(error ? { error } : {}) };
  }
  if (value.kind === 'skill') {
    const parsed = parseSecretarySkillDraft(value.draft);
    if (!parsed.ok) return undefined;
    const previous =
      isObject(value.previous) &&
      typeof value.previous.description === 'string' &&
      typeof value.previous.body === 'string'
        ? { description: value.previous.description, body: value.previous.body }
        : undefined;
    return {
      ...base,
      kind: 'skill',
      draft: parsed.draft,
      ...(previous ? { previous } : {}),
      ...(error ? { error } : {}),
    };
  }
  if (value.kind === 'tool') {
    const parsed = parseSecretaryToolDraft(value.draft);
    if (!parsed.ok) return undefined;
    const previous = isObject(value.previous) ? parseSecretaryToolDraft(value.previous) : null;
    return {
      ...base,
      kind: 'tool',
      draft: parsed.draft,
      ...(previous?.ok ? { previous: previous.draft } : {}),
      ...(error ? { error } : {}),
    };
  }
  if (value.kind === 'takeover') {
    const draft = parseTakeoverDraft(value.draft);
    if (!draft) return undefined;
    return { ...base, kind: 'takeover', draft, ...(error ? { error } : {}) };
  }
  return undefined;
}

export function parseTakeoverDraft(value: unknown): TakeoverDraft | undefined {
  if (!isObject(value)) return undefined;
  const conversationId = text(value.conversationId);
  const projectId = text(value.projectId);
  if (!conversationId || !projectId) return undefined;
  const title = text(value.title);
  const reason = text(value.reason);
  return {
    conversationId,
    projectId,
    ...(title ? { title } : {}),
    ...(reason ? { reason } : {}),
  };
}

function parseRecord(value: unknown): DispatchRecord | undefined {
  if (!isObject(value)) return undefined;
  const conversationId = text(value.conversationId);
  const projectId = text(value.projectId);
  const secretaryConversationId = text(value.secretaryConversationId);
  const createdAt = time(value.createdAt);
  const lastEventAt = time(value.lastEventAt);
  if (!conversationId || !projectId || !secretaryConversationId) return undefined;
  if (createdAt === undefined || lastEventAt === undefined) return undefined;
  if (!['running', 'idle', 'waiting', 'error'].includes(value.lastState as string))
    return undefined;
  const record: DispatchRecord = {
    conversationId,
    projectId,
    secretaryConversationId,
    createdAt,
    turn: count(value.turn) ?? 0,
    lastState: value.lastState as DispatchRecord['lastState'],
    lastEventAt,
  };
  const todoId = text(value.todoId);
  if (todoId) record.todoId = todoId;
  const goal = text(value.goal);
  if (goal) record.goal = goal;
  const lastText = text(value.lastText);
  if (lastText) record.lastText = lastText;
  const stalledTurn = count(value.stalledTurn);
  if (stalledTurn) record.stalledTurn = stalledTurn;
  const stateSince = time(value.stateSince);
  if (stateSince !== undefined) record.stateSince = stateSince;
  if (
    isObject(value.lastResult) &&
    RESULT_KINDS.includes(value.lastResult.kind as SecretaryResultKind)
  ) {
    const turn = count(value.lastResult.turn);
    const at = time(value.lastResult.at);
    if (turn !== undefined && at !== undefined)
      record.lastResult = {
        kind: value.lastResult.kind as SecretaryResultKind,
        turn,
        at,
        ...(value.lastResult.dismissed === true ? { dismissed: true as const } : {}),
      };
  }
  if (value.takeover !== undefined) {
    // 接管标记坏了就整条不认：不能退化成一条撤不掉的派出记录
    if (!isObject(value.takeover)) return undefined;
    const grantedAt = time(value.takeover.grantedAt);
    const via = value.takeover.via;
    if (grantedAt === undefined || (via !== 'proposal' && via !== 'user')) return undefined;
    record.takeover = { grantedAt, via };
  }
  return record;
}

function parseUpdate(value: unknown): SecretaryUpdate | undefined {
  if (!isObject(value)) return undefined;
  const key = text(value.key);
  const at = time(value.at);
  if (!key || at === undefined || typeof value.text !== 'string') return undefined;
  const base = { key, at, text: value.text };
  const lastText = text(value.lastText);
  const secretaryConversationId = text(value.secretaryConversationId);
  const scope = {
    ...(lastText ? { lastText } : {}),
    ...(secretaryConversationId ? { secretaryConversationId } : {}),
  };
  if (RESULT_KINDS.includes(value.kind as SecretaryResultKind)) {
    const conversationId = text(value.conversationId);
    if (!conversationId) return undefined;
    return { ...base, ...scope, kind: value.kind as SecretaryResultKind, conversationId };
  }
  if (value.kind === 'proposal') {
    const proposalId = text(value.proposalId);
    if (!proposalId || !PROPOSAL_STATUSES.includes(value.status as ProposalStatus))
      return undefined;
    return {
      ...base,
      ...scope,
      kind: 'proposal',
      proposalId,
      status: value.status as ProposalStatus,
    };
  }
  if (value.kind === 'schedule') {
    const scheduleId = text(value.scheduleId);
    if (!scheduleId) return undefined;
    return { ...base, ...scope, kind: 'schedule', scheduleId };
  }
  return undefined;
}

function parseInflight(value: unknown): SecretaryDispatchFile['inflight'] {
  if (!isObject(value)) return undefined;
  const deliveryId = text(value.deliveryId);
  const secretaryConversationId = text(value.secretaryConversationId);
  if (!deliveryId || !secretaryConversationId) return undefined;
  return {
    deliveryId,
    secretaryConversationId,
    keys: texts(value.keys),
    attempt: clampInt(value.attempt, 1, 6) ?? 1,
    nextAttemptAt: time(value.nextAttemptAt) ?? 0,
    ...(typeof value.settled === 'boolean' ? { settled: value.settled } : {}),
  };
}

export function parseDispatchFile(value: unknown): SecretaryDispatchFile {
  const file: SecretaryDispatchFile = {
    version: 1,
    dispatched: {},
    named: [],
    proposals: {},
    outbox: [],
  };
  if (!isObject(value)) return file;
  if (isObject(value.dispatched)) {
    for (const item of Object.values(value.dispatched)) {
      const record = parseRecord(item);
      if (record) file.dispatched[record.conversationId] = record;
    }
  }
  file.named = texts(value.named);
  if (isObject(value.proposals)) {
    for (const item of Object.values(value.proposals)) {
      const proposal = parseProposal(item);
      if (proposal) file.proposals[proposal.id] = proposal;
    }
  }
  if (Array.isArray(value.outbox)) {
    for (const item of value.outbox) {
      const update = parseUpdate(item);
      if (update) file.outbox.push(update);
    }
  }
  const inflight = parseInflight(value.inflight);
  if (inflight) file.inflight = inflight;
  return file;
}

export function parseTodos(value: unknown): SecretaryTodo[] {
  if (!Array.isArray(value)) return [];
  const todos: SecretaryTodo[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const id = text(item.id);
    const todoText = text(item.text);
    const createdAt = time(item.createdAt);
    const updatedAt = time(item.updatedAt);
    if (!id || !todoText || createdAt === undefined || updatedAt === undefined) continue;
    const todo: SecretaryTodo = { id, text: todoText, createdAt, updatedAt };
    const dueAt = time(item.dueAt);
    if (dueAt !== undefined) todo.dueAt = dueAt;
    const projectId = text(item.projectId);
    if (projectId) todo.projectId = projectId;
    const conversationId = text(item.conversationId);
    if (conversationId) todo.conversationId = conversationId;
    const doneAt = time(item.doneAt);
    if (doneAt !== undefined) todo.doneAt = doneAt;
    todos.push(todo);
  }
  return todos;
}

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isCron(value: unknown): value is string {
  return typeof value === 'string' && value.trim().split(/\s+/u).length === 5;
}

export function parseSchedules(value: unknown): SecretarySchedule[] {
  if (!Array.isArray(value)) return [];
  const schedules: SecretarySchedule[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const id = text(item.id);
    const name = text(item.name);
    const prompt = text(item.prompt);
    const createdAt = time(item.createdAt);
    if (!id || !name || !prompt || createdAt === undefined) continue;
    if (schedules.some((schedule) => schedule.id === id)) continue;
    const at = isIsoTime(item.at) ? item.at : undefined;
    const cron = isCron(item.cron) ? item.cron.trim() : undefined;
    if (Boolean(at) === Boolean(cron)) continue;
    const schedule: SecretarySchedule = at
      ? { id, name, prompt, createdAt, at }
      : { id, name, prompt, createdAt, cron: cron as string };
    const lastFiredAt = time(item.lastFiredAt);
    if (lastFiredAt !== undefined) schedule.lastFiredAt = lastFiredAt;
    if (item.system === 'daily-brief') schedule.system = 'daily-brief';
    else if (isObject(item.system) && text(item.system.todoId))
      schedule.system = { todoId: text(item.system.todoId)! };
    schedules.push(schedule);
  }
  return schedules;
}
