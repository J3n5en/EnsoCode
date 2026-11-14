import path from 'node:path';
import { app } from '@platform';
import { projectNameFromPath } from '@shared/projectName';
import {
  buildSecretaryDaily,
  DAILY_RETENTION_DAYS,
  dayKey,
  parseDayKey,
} from '@shared/secretary/daily';
import type { ProjectAuthority } from '@shared/types/agent';
import type { SecretaryDaily, SecretaryDispatchFile, SecretaryTodo } from '@shared/types/secretary';
import { readAudit } from './audit';
import { readDailyRecords } from './dailyLog';
import { SecretaryStore } from './store';

type MaybePromise<T> = T | Promise<T>;

/** 看板只读数据源；测试注入假实现，生产走文件末尾的 secretaryDailyPorts */
export interface SecretaryDailyPorts {
  dir(): string;
  dispatchFile(): SecretaryDispatchFile;
  todos(): MaybePromise<SecretaryTodo[]>;
  rows(): MaybePromise<Record<string, Record<string, unknown>>>;
  projects(): MaybePromise<readonly ProjectAuthority[]>;
  now(): number;
}

/** IPC 入参：缺省就是今天。null 表示非法 */
export function parseDailyRequest(value: unknown, now: number): string | null {
  if (value == null) return dayKey(now);
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const day = (value as Record<string, unknown>).day;
  if (day === undefined) return dayKey(now);
  return parseDayKey(day);
}

/**
 * 一天的看板。数据全部来自 Main 的持久化：派发记录（派出时间）、daily.jsonl（结果）、
 * audit.jsonl（设置与能力变更）、todos.json（待办历史）。
 */
export async function buildDaily(ports: SecretaryDailyPorts, day: string): Promise<SecretaryDaily> {
  const file = ports.dispatchFile();
  const rows = await ports.rows();
  const projects = await ports.projects();
  const results = readDailyRecords(ports.dir());
  const audit = readAudit(ports.dir());
  const todos = await ports.todos();
  const dispatched = Object.values(file.dispatched);

  const projectName = (projectId: string): string => {
    const project = projects.find((candidate) => candidate.projectId === projectId);
    return project ? projectNameFromPath(project.canonicalPath) : '';
  };

  const session = (conversationId: string): { title?: string; projectName?: string } => {
    const row = rows[conversationId];
    if (!row) return {};
    const title = typeof row.title === 'string' && row.title.trim() ? row.title : undefined;
    const projectId = typeof row.projectId === 'string' ? row.projectId : undefined;
    return {
      ...(title ? { title } : {}),
      ...(projectId ? { projectName: projectName(projectId) } : {}),
    };
  };

  const earliest = earliestOf(results, dispatched, todos, audit);
  return buildSecretaryDaily({
    day,
    now: ports.now(),
    results,
    dispatched,
    todos,
    audit,
    session,
    projectName,
    ...(earliest ? { earliest } : {}),
    retentionDays: DAILY_RETENTION_DAYS,
  });
}

/** 所有来源里最早的一天：界面据此说明能回看多久 */
function earliestOf(
  results: readonly { at: number }[],
  dispatched: readonly { createdAt: number }[],
  todos: readonly SecretaryTodo[],
  audit: readonly { at: number }[]
): string | undefined {
  let earliest: number | undefined;
  const consider = (at: number | undefined): void => {
    if (at === undefined || at <= 0) return;
    if (earliest === undefined || at < earliest) earliest = at;
  };
  for (const record of results) consider(record.at);
  for (const record of dispatched) consider(record.createdAt);
  for (const todo of todos) {
    consider(todo.createdAt);
    consider(todo.doneAt);
  }
  for (const entry of audit) consider(entry.at);
  return earliest === undefined ? undefined : dayKey(earliest);
}

function secretaryDir(): string {
  return path.join(app.getPath('userData'), 'secretary');
}

function store(): SecretaryStore {
  return new SecretaryStore(secretaryDir());
}

/** 与秘书其余入口同源：会话行与项目都取 Main 的权威投影，动态 import 避免与 ipc 成环 */
export const secretaryDailyPorts: SecretaryDailyPorts = {
  dir: secretaryDir,
  dispatchFile: () => store().dispatch(),
  todos: () => store().todos(),
  rows: async () => (await import('../../ipc/settings')).readPersistedConversations(),
  projects: async () =>
    (await import('../../ipc/agent')).getSourceAuthorityRegistry()?.projection().projects ?? [],
  now: () => Date.now(),
};
