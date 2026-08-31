import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeConversationSessionFiles } from './sessionFileCleanup';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

describe('removeConversationSessionFiles', () => {
  let root: string;
  let sessionDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'enso-session-cleanup-'));
    sessionDir = path.join(root, 'agent', 'sessions');
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('删除父会话 jsonl 与 coworker safe journal，保留无关文件', () => {
    const parentFile = path.join(sessionDir, '2026-08-29T00-00-00-000Z_abc.jsonl');
    const coworkerFile = path.join(sessionDir, `enso-${CONVERSATION_ID}__cw-deadbeef-gen.jsonl`);
    const otherParent = path.join(sessionDir, '2026-08-29T00-00-00-000Z_other.jsonl');
    const otherCoworker = path.join(
      sessionDir,
      'enso-22222222-2222-4222-8222-222222222222__cw-x-gen.jsonl'
    );
    for (const file of [parentFile, coworkerFile, otherParent, otherCoworker]) {
      writeFileSync(file, '{}\n');
    }

    removeConversationSessionFiles({
      sessionDir,
      conversationId: CONVERSATION_ID,
      sessionFile: parentFile,
    });

    expect(existsSync(parentFile)).toBe(false);
    expect(existsSync(coworkerFile)).toBe(false);
    expect(existsSync(otherParent)).toBe(true);
    expect(existsSync(otherCoworker)).toBe(true);
  });

  it('sessionFile 落在 sessions 目录外时拒绝删除（防穿越）', () => {
    const outside = path.join(root, 'outside.jsonl');
    writeFileSync(outside, '{}\n');

    removeConversationSessionFiles({
      sessionDir,
      conversationId: CONVERSATION_ID,
      sessionFile: outside,
    });

    expect(existsSync(outside)).toBe(true);
  });

  it('sessionFile 带 .. 分量穿越到目录外时拒绝删除', () => {
    const outside = path.join(root, 'escape.jsonl');
    writeFileSync(outside, '{}\n');

    removeConversationSessionFiles({
      sessionDir,
      conversationId: CONVERSATION_ID,
      sessionFile: path.join(sessionDir, '..', '..', 'escape.jsonl'),
    });

    expect(existsSync(outside)).toBe(true);
  });

  it('无 sessionFile（draft 会话）时仍清理 coworker 文件且不抛错', () => {
    const coworkerFile = path.join(sessionDir, `enso-${CONVERSATION_ID}__cw-a-gen.jsonl`);
    writeFileSync(coworkerFile, '{}\n');

    expect(() =>
      removeConversationSessionFiles({ sessionDir, conversationId: CONVERSATION_ID })
    ).not.toThrow();
    expect(existsSync(coworkerFile)).toBe(false);
  });

  it('sessions 目录不存在时不抛错', () => {
    expect(() =>
      removeConversationSessionFiles({
        sessionDir: path.join(root, 'missing'),
        conversationId: CONVERSATION_ID,
        sessionFile: path.join(root, 'missing', 'a.jsonl'),
      })
    ).not.toThrow();
  });
});
