import { readFileSync } from 'node:fs';
import path from 'node:path';
import { app } from '@platform';
import {
  parseReminderFile,
  REMINDERS_FILE,
  remindersOf,
  rootIdOfReminder,
  type SessionReminder,
  type SessionReminderSummary,
  toReminderSummary,
} from '@shared/reminders';

function readReminderFile(sessionDir: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(sessionDir, REMINDERS_FILE), 'utf8'));
  } catch {
    return parseReminderFile(null);
  }
  return parseReminderFile(raw);
}

/** 根会话自己及其子会话挂着的自定提醒；文件由 worker 写，缺失或损坏返回空 */
export function readSessionReminders(
  rootId: string,
  sessionDir = path.join(app.getPath('userData'), 'agent', 'sessions')
): SessionReminder[] {
  return remindersOf(readReminderFile(sessionDir), rootId);
}

/** 所有根会话当前挂着的提醒摘要（按根会话聚合、按到点时间升序），供渲染层初始化拉取 */
export function readAllSessionReminders(
  sessionDir = path.join(app.getPath('userData'), 'agent', 'sessions')
): Record<string, SessionReminderSummary[]> {
  const file = readReminderFile(sessionDir);
  const byRoot: Record<string, SessionReminderSummary[]> = {};
  for (const item of file.reminders) {
    const rootId = rootIdOfReminder(item.sessionId);
    const list = byRoot[rootId] ?? [];
    byRoot[rootId] = list;
    list.push(toReminderSummary(item));
  }
  for (const list of Object.values(byRoot)) {
    list.sort((a, b) => a.dueAt - b.dueAt);
  }
  return byRoot;
}
