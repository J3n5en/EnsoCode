import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeClaudeProjectDir, listClaudeSessions, readClaudeSession } from './claudeCode';
import { readCodexSession } from './codex';
import { writePiSession } from './piJsonl';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-simport-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const jsonl = (entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join('\n');

describe('encodeClaudeProjectDir', () => {
  it('非字母数字统一替换为连字符', () => {
    expect(encodeClaudeProjectDir('/Users/x/.config/My App')).toBe('-Users-x--config-My-App');
  });
});

describe('readClaudeSession', () => {
  it('提取文本轮次，取 ai-title 作标题，过滤 sidechain 与系统噪声', () => {
    const file = path.join(tmp, 's.jsonl');
    fs.writeFileSync(
      file,
      jsonl([
        { type: 'mode', mode: 'normal' },
        { type: 'ai-title', title: '修复登录问题' },
        {
          type: 'user',
          timestamp: '2026-08-01T00:00:00Z',
          message: { role: 'user', content: '登录挂了' },
        },
        { type: 'user', isSidechain: true, message: { role: 'user', content: '子代理消息' } },
        {
          type: 'user',
          message: { role: 'user', content: '<system-reminder>噪声</system-reminder>' },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '想想' },
              { type: 'text', text: '已修复' },
            ],
          },
        },
      ])
    );
    const { title, messages } = readClaudeSession(file);
    expect(title).toBe('修复登录问题');
    expect(messages).toEqual([
      { role: 'user', text: '登录挂了', timestamp: Date.parse('2026-08-01T00:00:00Z') },
      { role: 'assistant', text: '已修复', timestamp: undefined },
    ]);
  });

  it('损坏的行不崩，整文件无消息时返回空', () => {
    const file = path.join(tmp, 'bad.jsonl');
    fs.writeFileSync(file, 'not-json\n{"type":"mode"}\n');
    expect(readClaudeSession(file).messages).toEqual([]);
  });
});

describe('listClaudeSessions', () => {
  it('列出项目编码目录下有消息的会话，按时间倒序', () => {
    const projectPath = '/tmp/demo';
    const dir = path.join(tmp, '.claude', 'projects', encodeClaudeProjectDir(projectPath));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'a.jsonl'),
      jsonl([{ type: 'user', message: { role: 'user', content: 'hi' } }])
    );
    fs.writeFileSync(path.join(dir, 'empty.jsonl'), jsonl([{ type: 'mode' }]));
    const sessions = listClaudeSessions(projectPath, tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].messageCount).toBe(1);
  });
});

describe('readCodexSession', () => {
  it('提取 response_item 消息，跳过指令噪声', () => {
    const file = path.join(tmp, 'rollout.jsonl');
    fs.writeFileSync(
      file,
      jsonl([
        { type: 'session_meta', payload: { cwd: '/tmp/demo' } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<user_instructions>x</user_instructions>' }],
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-08-02T00:00:00Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '改个 bug' }],
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '改好了' }],
          },
        },
      ])
    );
    const { title, messages } = readCodexSession(file);
    expect(title).toBe('改个 bug');
    expect(messages.map((m) => m.text)).toEqual(['改个 bug', '改好了']);
  });
});

describe('writePiSession', () => {
  it('产出 header + 消息链，parentId 依次串联', () => {
    const file = writePiSession(
      '/tmp/demo',
      [
        { role: 'user', text: 'hi', timestamp: 1000 },
        { role: 'assistant', text: 'hello', timestamp: 2000 },
      ],
      tmp
    );
    const lines = fs
      .readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: 'session', version: 3, cwd: '/tmp/demo' });
    expect(lines[1]).toMatchObject({
      type: 'message',
      parentId: null,
      message: { role: 'user', content: 'hi' },
    });
    expect(lines[2].parentId).toBe(lines[1].id);
    expect(lines[2].message).toMatchObject({ role: 'assistant', stopReason: 'stop' });
  });
});
