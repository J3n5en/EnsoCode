import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordChildRun } from './childRunCatalog';
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

  it('删除该会话及其子会话的 tool-output 目录，保留其他会话的', () => {
    const toolRoot = path.join(sessionDir, 'tool-output');
    const own = path.join(toolRoot, CONVERSATION_ID);
    const child = path.join(toolRoot, `${CONVERSATION_ID}-child`);
    const other = path.join(toolRoot, '22222222-2222-4222-8222-222222222222');
    for (const dir of [own, child, other]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'toolu_1.txt'), 'x');
    }

    removeConversationSessionFiles({ sessionDir, conversationId: CONVERSATION_ID });

    expect(existsSync(own)).toBe(false);
    expect(existsSync(child)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('删除该会话及其子会话未投递的通知文件，保留其他会话的', () => {
    const pendingRoot = path.join(sessionDir, 'pending-notifications');
    mkdirSync(pendingRoot, { recursive: true });
    const file = (id: string) => path.join(pendingRoot, `${encodeURIComponent(id)}.json`);
    const own = file(CONVERSATION_ID);
    const child = file(`${CONVERSATION_ID}::cw-abc`);
    const other = file('22222222-2222-4222-8222-222222222222');
    for (const target of [own, child, other]) writeFileSync(target, '["x"]');

    removeConversationSessionFiles({ sessionDir, conversationId: CONVERSATION_ID });

    expect(existsSync(own)).toBe(false);
    expect(existsSync(child)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('删除 scratch 会话目录，不越界删到根目录或其他会话', () => {
    const scratchRoot = path.join(root, 'scratch');
    const own = path.join(scratchRoot, CONVERSATION_ID);
    const other = path.join(scratchRoot, '22222222-2222-4222-8222-222222222222');
    mkdirSync(own, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(own, 'note.txt'), 'x');
    writeFileSync(path.join(scratchRoot, 'keep.txt'), 'y');

    removeConversationSessionFiles({
      sessionDir,
      conversationId: CONVERSATION_ID,
      scratchRoot,
    });

    expect(existsSync(own)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(path.join(scratchRoot, 'keep.txt'))).toBe(true);

    removeConversationSessionFiles({
      sessionDir,
      conversationId: `../${CONVERSATION_ID}`,
      scratchRoot,
    });
    expect(existsSync(scratchRoot)).toBe(true);
  });

  it('删除父会话时连带删除 catalog 登记的普通子 pi jsonl', () => {
    const childFile = path.join(sessionDir, '2026-08-29T00-00-00-000Z_child.jsonl');
    const otherChild = path.join(sessionDir, '2026-08-29T00-00-00-000Z_other-child.jsonl');
    const otherParent = '22222222-2222-4222-8222-222222222222';
    writeFileSync(childFile, '{}\n');
    writeFileSync(otherChild, '{}\n');
    recordChildRun(sessionDir, CONVERSATION_ID, {
      v: 1,
      childId: `${CONVERSATION_ID}::cw-child`,
      name: 'scout',
      file: path.basename(childFile),
      startedAt: 1,
    });
    recordChildRun(sessionDir, otherParent, {
      v: 1,
      childId: `${otherParent}::cw-child`,
      name: 'other',
      file: path.basename(otherChild),
      startedAt: 1,
    });

    removeConversationSessionFiles({ sessionDir, conversationId: CONVERSATION_ID });

    expect(existsSync(childFile)).toBe(false);
    expect(existsSync(path.join(sessionDir, 'child-runs', `${CONVERSATION_ID}.jsonl`))).toBe(false);
    expect(existsSync(otherChild)).toBe(true);
    expect(existsSync(path.join(sessionDir, 'child-runs', `${otherParent}.jsonl`))).toBe(true);
  });
});
