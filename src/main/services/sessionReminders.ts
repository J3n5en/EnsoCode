import { readFileSync } from 'node:fs';
import path from 'node:path';
import { app } from '@platform';
import {
  parseReminderFile,
  REMINDERS_FILE,
  remindersOf,
  type SessionReminder,
} from '@shared/reminders';

/** 根会话自己及其子会话挂着的自定提醒；文件由 worker 写，缺失或损坏返回空 */
export function readSessionReminders(
  rootId: string,
  sessionDir = path.join(app.getPath('userData'), 'agent', 'sessions')
): SessionReminder[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(sessionDir, REMINDERS_FILE), 'utf8'));
  } catch {
    return [];
  }
  return remindersOf(parseReminderFile(raw), rootId);
}
