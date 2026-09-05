import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifySessionFile, extractPersistableMessages, listMemoryThreads } from './threads';

function sessionDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'enso-threads-'));
}

function writeJsonl(file: string, rows: unknown[]): void {
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

describe('classifySessionFile', () => {
  it('marks coworker and child journals from filename', () => {
    expect(classifySessionFile('2026-09-05T00-00-00-000Z_abc.jsonl')).toBe('parent');
    expect(classifySessionFile('enso-sess__cw-deadbeef-1.jsonl')).toBe('coworker');
    expect(classifySessionFile('enso-parent-child-2.jsonl')).toBe('child');
  });
});

describe('listMemoryThreads', () => {
  it('reads session header cwd/id and mtime, skips non-jsonl and other cwd', async () => {
    const dir = sessionDir();
    const parent = path.join(dir, 'idle-parent.jsonl');
    writeJsonl(parent, [
      { type: 'session', id: 'thread-1', cwd: '/Users/me/proj' },
      { type: 'message', message: { role: 'user', content: 'hi' } },
    ]);
    const other = path.join(dir, 'other-cwd.jsonl');
    writeJsonl(other, [{ type: 'session', id: 'thread-x', cwd: '/Users/me/other' }]);
    writeFileSync(path.join(dir, 'notes.txt'), 'ignore');
    const nowSec = 1_800_000_000;
    utimesSync(parent, nowSec - 50_000, nowSec - 50_000);

    const threads = await listMemoryThreads(dir, { cwd: '/Users/me/proj' });
    expect(threads).toEqual([
      {
        threadId: 'thread-1',
        sessionFile: parent,
        cwd: '/Users/me/proj',
        updatedAtSec: nowSec - 50_000,
        sourceKind: 'parent',
      },
    ]);
  });
});

describe('extractPersistableMessages', () => {
  it('keeps user/assistant text and small tool results; drops images', () => {
    const payload = [
      { type: 'session', id: 't' },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'fix login' }] },
      },
      {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'read',
          content: [{ type: 'text', text: 'file body' }],
        },
      },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'image', data: 'abc' }] },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');

    expect(extractPersistableMessages(payload)).toEqual([
      { role: 'user', text: 'fix login' },
      { role: 'assistant', text: 'ok' },
      { role: 'toolResult', toolName: 'read', text: 'file body' },
    ]);
  });

  it('caps oversized read tool result to head+tail with a truncation marker instead of dropping it', () => {
    const head = 'H'.repeat(900);
    const tail = 'T'.repeat(600);
    const huge = `${head}${'x'.repeat(30_000)}${tail}`;
    const payload = JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'read',
        content: [{ type: 'text', text: huge }],
      },
    });

    const [result] = extractPersistableMessages(payload);

    expect(result.text.length).toBeLessThanOrEqual(1_600);
    expect(result.text).toContain('truncated');
    expect(result.text.startsWith(head)).toBe(true);
    expect(result.text.endsWith(tail)).toBe(true);
  });

  it('leaves a ~1k tool result untouched', () => {
    const body = 'y'.repeat(1_000);
    const payload = JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'bash',
        content: [{ type: 'text', text: body }],
      },
    });

    const [result] = extractPersistableMessages(payload);

    expect(result.text).toBe(body);
  });

  it('混合 system/developer/user/assistant/toolResult 时保持原始顶序', () => {
    const payload = [
      {
        type: 'message',
        message: { role: 'system', content: [{ type: 'text', text: 'sys prompt' }] },
      },
      {
        type: 'message',
        message: { role: 'developer', content: [{ type: 'text', text: 'dev note' }] },
      },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'user turn 1' }] },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'bash',
          content: [{ type: 'text', text: 'tool output' }],
        },
      },
      {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'assistant reply' }] },
      },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'user turn 2' }] },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');

    expect(extractPersistableMessages(payload)).toEqual([
      { role: 'system', text: 'sys prompt' },
      { role: 'developer', text: 'dev note' },
      { role: 'user', text: 'user turn 1' },
      { role: 'toolResult', toolName: 'bash', text: 'tool output' },
      { role: 'assistant', text: 'assistant reply' },
      { role: 'user', text: 'user turn 2' },
    ]);
  });

  it('keeps only bash/eval/read/grep tool results, matching OMP', () => {
    const payload = [
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'write',
          content: [{ type: 'text', text: 'wrote file' }],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ls ok' }],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');
    expect(extractPersistableMessages(payload)).toEqual([
      { role: 'toolResult', toolName: 'bash', text: 'ls ok' },
    ]);
  });
});
