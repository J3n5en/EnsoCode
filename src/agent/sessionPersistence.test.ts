import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterAll, describe, expect, it } from 'vitest';
import { materializeSessionFile } from './supervisor';

// 真实 SessionManager：这里要验的是磁盘上的可观测结果，mock 掉就失去意义。
const root = mkdtempSync(path.join(tmpdir(), 'enso-session-persist-'));
const sessionDir = path.join(root, 'sessions');
const cwd = path.join(root, 'project');

afterAll(() => rmSync(root, { recursive: true, force: true }));

function sessionWith(manager: SessionManager, messages: unknown[]): AgentSession {
  return { sessionManager: manager, messages } as unknown as AgentSession;
}

function entriesOf(file: string): { type?: string; customType?: string }[] {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('派发父容器的 custom entry 必须能落盘', () => {
  it('没有 assistant 消息时，pi 自己不落盘，materialize 之后文件存在且含该 entry', () => {
    const manager = SessionManager.create(cwd, sessionDir);
    const file = manager.getSessionFile();
    expect(file).toBeTruthy();
    if (!file) return;

    manager.appendCustomEntry('enso-agent-session', { kind: 'agent-dispatch' });

    // 上游行为基线：pi 的 _persist 在出现第一条 assistant 消息前一个字节都不写。
    // 若哪天 pi 改了这个启发式，这条断言会先飘红，提醒复检本适配层是否还需要。
    expect(existsSync(file)).toBe(false);

    materializeSessionFile(sessionWith(manager, []));

    expect(existsSync(file)).toBe(true);
    const customs = entriesOf(file).filter((entry) => entry.type === 'custom');
    expect(customs).toHaveLength(1);
    expect(customs[0]?.customType).toBe('enso-agent-session');
  });

  it('多条通知都要在文件里，不能只留第一条', () => {
    const manager = SessionManager.create(cwd, sessionDir);
    const file = manager.getSessionFile();
    if (!file) return;

    const session = sessionWith(manager, []);
    for (const kind of ['agent-dispatch', 'agent-completed', 'agent-dispatch']) {
      manager.appendCustomEntry('enso-agent-session', { kind });
      materializeSessionFile(session);
    }

    expect(entriesOf(file).filter((entry) => entry.type === 'custom')).toHaveLength(3);
  });

  it('已有 assistant 消息时交还给 pi 自己持久化，不重复介入', () => {
    const manager = SessionManager.create(cwd, sessionDir);
    const file = manager.getSessionFile();
    if (!file) return;

    // pi 已接管：materialize 不该再强制重写（此处仅断言不抛错、不破坏已有内容）
    materializeSessionFile(sessionWith(manager, [{ role: 'assistant' }]));
    expect(existsSync(file)).toBe(false);
  });
});
