import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeClaudeProjectDir, listClaudeSessions, readClaudeSession } from './claudeCode';
import { listCodexSessions, readCodexSession } from './codex';
import { importExternalSession, listExternalSessions, readExternalSession } from './index';
import { writePiSession } from './piJsonl';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-simport-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

describe('listCodexSessions', () => {
  const writeRollout = (home: string, cwd: string, metaPadding = '') => {
    const dir = path.join(home, '.codex', 'sessions', '2026', '09', '08');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `rollout-${crypto.randomUUID()}.jsonl`),
      jsonl([
        { type: 'session_meta', payload: { cwd, metaPadding } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Windows 会话' }],
          },
        },
      ])
    );
  };

  it('Windows 未设置 HOME 时从系统用户目录扫描 Codex 会话', () => {
    writeRollout(tmp, 'D:\\Work\\Demo');
    vi.stubEnv('HOME', undefined);
    vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    expect(listCodexSessions('D:\\Work\\Demo')).toHaveLength(1);
  });

  it('session_meta 首行超过 4096 字节时仍能识别项目目录', () => {
    writeRollout(tmp, 'D:\\Work\\Demo', 'x'.repeat(5000));
    expect(listCodexSessions('D:\\Work\\Demo', tmp)).toHaveLength(1);
  });

  it('Windows 路径仅盘符或目录大小写不同时仍视为同一项目', () => {
    writeRollout(tmp, 'd:\\work\\demo');
    expect(listCodexSessions('D:\\Work\\Demo', tmp)).toHaveLength(1);
  });
});

const grokSessionDir = (home: string, projectPath: string, id: string) => {
  const dir = path.join(home, '.grok', 'sessions', encodeURIComponent(projectPath), id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

describe('外部会话编排', () => {
  it('未知 sourceId 读取时返回空消息', () => {
    expect(readExternalSession('nope', path.join(tmp, 'x.jsonl'))).toEqual([]);
  });

  it('未知 sourceId 导入时返回 null', () => {
    expect(importExternalSession('nope', path.join(tmp, 'x.jsonl'), '/tmp/demo', tmp)).toBeNull();
  });

  it('home 可注入，Grok 来源出现在列表里', () => {
    const projectPath = '/tmp/demo';
    const dir = grokSessionDir(tmp, projectPath, 'sess-1');
    fs.writeFileSync(
      path.join(dir, 'chat_history.jsonl'),
      jsonl([{ type: 'user', content: '你好' }])
    );
    const grok = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'grok');
    expect(grok?.sourceName).toBe('Grok CLI');
  });

  it('Windows 未设置 HOME 时统一从系统用户目录扫描本地应用', () => {
    const projectPath = '/tmp/demo';
    const dir = grokSessionDir(tmp, projectPath, 'sess-1');
    fs.writeFileSync(
      path.join(dir, 'chat_history.jsonl'),
      jsonl([{ type: 'user', content: '你好' }])
    );
    vi.stubEnv('HOME', undefined);
    vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    expect(listExternalSessions(projectPath).map((source) => source.sourceId)).toContain('grok');
  });
});

describe('Grok CLI 会话', () => {
  const projectPath = '/tmp/demo';

  it('列出会话时用 summary.json 的标题与 chat_history.jsonl 路径', () => {
    const dir = grokSessionDir(tmp, projectPath, 'sess-1');
    fs.writeFileSync(
      path.join(dir, 'chat_history.jsonl'),
      jsonl([{ type: 'user', content: '你好' }])
    );
    fs.writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify({ session_summary: '排查构建失败', updated_at: '2026-09-01T00:00:00Z' })
    );
    const grok = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'grok');
    expect(grok?.sessions).toEqual([
      expect.objectContaining({
        path: path.join(dir, 'chat_history.jsonl'),
        title: '排查构建失败',
        messageCount: 1,
      }),
    ]);
  });

  it('读取时提取 user/assistant 文本轮次', () => {
    const dir = grokSessionDir(tmp, projectPath, 'sess-1');
    const file = path.join(dir, 'chat_history.jsonl');
    fs.writeFileSync(
      file,
      jsonl([
        { type: 'user', content: '构建挂了' },
        { type: 'assistant', content: [{ type: 'text', text: '已修复' }] },
      ])
    );
    expect(readExternalSession('grok', file)).toEqual([
      expect.objectContaining({ role: 'user', text: '构建挂了' }),
      expect.objectContaining({ role: 'assistant', text: '已修复' }),
    ]);
  });

  it('跳过 system/reasoning/tool_result 与合成注入，并抽出 user_query 正文', () => {
    const dir = grokSessionDir(tmp, projectPath, 'sess-1');
    const file = path.join(dir, 'chat_history.jsonl');
    fs.writeFileSync(
      file,
      jsonl([
        { type: 'system', content: '系统提示' },
        { type: 'reasoning', content: '想想' },
        { type: 'tool_result', content: '工具输出' },
        { type: 'user', content: '<user_query>真正的问题</user_query>' },
        { type: 'user', content: '技能注入', synthetic_reason: 'skill' },
      ])
    );
    expect(readExternalSession('grok', file)).toEqual([
      expect.objectContaining({ role: 'user', text: '真正的问题' }),
    ]);
  });

  it('损坏的 jsonl 与缺失文件都返回空消息且不抛错', () => {
    const dir = grokSessionDir(tmp, projectPath, 'sess-1');
    const file = path.join(dir, 'chat_history.jsonl');
    fs.writeFileSync(file, 'not-json\n{"type":"system"}\n');
    expect(readExternalSession('grok', file)).toEqual([]);
    expect(readExternalSession('grok', path.join(dir, 'missing.jsonl'))).toEqual([]);
  });

  it('只列出当前项目编码目录下的会话', () => {
    const mine = grokSessionDir(tmp, projectPath, 'sess-1');
    fs.writeFileSync(
      path.join(mine, 'chat_history.jsonl'),
      jsonl([{ type: 'user', content: 'a' }])
    );
    const other = grokSessionDir(tmp, '/tmp/other', 'sess-2');
    fs.writeFileSync(
      path.join(other, 'chat_history.jsonl'),
      jsonl([{ type: 'user', content: 'b' }])
    );
    const grok = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'grok');
    expect(grok?.sessions.map((s) => s.path)).toEqual([path.join(mine, 'chat_history.jsonl')]);
  });
});

const cursorTranscript = (home: string, projectPath: string, id: string) => {
  const dir = path.join(
    home,
    '.cursor',
    'projects',
    projectPath.replace(/^\//, '').replaceAll('/', '-'),
    'agent-transcripts',
    id
  );
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.jsonl`);
};

const cursorTurn = (role: string, text: string) => ({
  role,
  message: { content: [{ type: 'text', text }] },
});

describe('Cursor 会话', () => {
  const projectPath = '/tmp/demo';

  it('列出会话时给出 Cursor 来源、jsonl 绝对路径与首条 user 标题', () => {
    const file = cursorTranscript(tmp, projectPath, 'tr-1');
    fs.writeFileSync(file, jsonl([cursorTurn('user', '<user_query>修复登录问题</user_query>')]));
    const cursor = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'cursor');
    expect(cursor?.sourceName).toBe('Cursor');
    expect(cursor?.sessions).toHaveLength(1);
    expect(cursor?.sessions[0].path).toBe(file);
    expect(cursor?.sessions[0].title).toContain('修复登录问题');
  });

  it('读取时提取 user/assistant 文本轮次', () => {
    const file = cursorTranscript(tmp, projectPath, 'tr-1');
    fs.writeFileSync(
      file,
      jsonl([cursorTurn('user', '构建挂了'), cursorTurn('assistant', '已修复')])
    );
    expect(readExternalSession('cursor', file)).toEqual([
      expect.objectContaining({ role: 'user', text: '构建挂了' }),
      expect.objectContaining({ role: 'assistant', text: '已修复' }),
    ]);
  });

  it('user 正文从 user_query 标签中抽出', () => {
    const file = cursorTranscript(tmp, projectPath, 'tr-1');
    fs.writeFileSync(
      file,
      jsonl([
        cursorTurn(
          'user',
          '<timestamp>2026-09-08</timestamp>\n<user_query>真正的问题</user_query>'
        ),
      ])
    );
    expect(readExternalSession('cursor', file)).toEqual([
      expect.objectContaining({ role: 'user', text: '真正的问题' }),
    ]);
  });

  it('整段以尖括号开头且抽不到 user_query 时跳过该轮次', () => {
    const file = cursorTranscript(tmp, projectPath, 'tr-1');
    fs.writeFileSync(
      file,
      jsonl([
        cursorTurn('user', '<environment_context>工作区快照</environment_context>'),
        cursorTurn('assistant', '收到'),
      ])
    );
    expect(readExternalSession('cursor', file)).toEqual([
      expect.objectContaining({ role: 'assistant', text: '收到' }),
    ]);
  });

  it('损坏的 jsonl 与缺失文件都返回空消息且不抛错', () => {
    const file = cursorTranscript(tmp, projectPath, 'tr-1');
    fs.writeFileSync(file, 'not-json\n{"role":"user"}\n');
    expect(readExternalSession('cursor', file)).toEqual([]);
    expect(readExternalSession('cursor', path.join(path.dirname(file), 'missing.jsonl'))).toEqual(
      []
    );
  });

  it('只列出当前项目编码目录下的会话', () => {
    const mine = cursorTranscript(tmp, projectPath, 'tr-1');
    fs.writeFileSync(mine, jsonl([cursorTurn('user', 'a')]));
    const other = cursorTranscript(tmp, '/tmp/other', 'tr-2');
    fs.writeFileSync(other, jsonl([cursorTurn('user', 'b')]));
    const cursor = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'cursor');
    expect(cursor?.sessions.map((s) => s.path)).toEqual([mine]);
  });
});

const piSessionFile = (home: string, root: '.pi' | '.omp', dirName: string, id: string) => {
  const dir = path.join(home, root, 'agent', 'sessions', dirName);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.jsonl`);
};

const piHeader = (cwd: string) => ({ type: 'session', version: 3, id: 'sid', cwd });
const piTurn = (role: string, content: unknown[]) => ({
  type: 'message',
  message: { role, content },
});
const piText = (text: string) => ({ type: 'text', text });

describe('pi / oh-my-pi 会话', () => {
  const projectPath = '/tmp/demo';

  it('列出 .pi 下 cwd 匹配的会话，来源为 pi，path 是 jsonl 本身', () => {
    const file = piSessionFile(tmp, '.pi', '-tmp-demo', 's1');
    fs.writeFileSync(file, jsonl([piHeader(projectPath), piTurn('user', [piText('hi')])]));
    const source = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'pi');
    expect(source?.sourceName).toBe('pi');
    expect(source?.sessions.map((s) => s.path)).toEqual([file]);
  });

  it('列出 .omp 下同样形状的会话，来源为 oh-my-pi', () => {
    const file = piSessionFile(tmp, '.omp', '-project-billcom-web', 's1');
    fs.writeFileSync(file, jsonl([piHeader(projectPath), piTurn('user', [piText('hi')])]));
    const source = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'oh-my-pi');
    expect(source?.sourceName).toBe('oh-my-pi');
    expect(source?.sessions.map((s) => s.path)).toEqual([file]);
  });

  it('标题优先用非空的 title 行', () => {
    const file = piSessionFile(tmp, '.pi', '-tmp-demo', 's1');
    fs.writeFileSync(
      file,
      jsonl([
        { type: 'title', title: '重构导入流程' },
        piHeader(projectPath),
        piTurn('user', [piText('先看看导入')]),
      ])
    );
    const source = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'pi');
    expect(source?.sessions[0].title).toBe('重构导入流程');
  });

  it('title 为空时回退到首条 user 文本', () => {
    const file = piSessionFile(tmp, '.pi', '-tmp-demo', 's1');
    fs.writeFileSync(
      file,
      jsonl([
        { type: 'title', title: '' },
        piHeader(projectPath),
        piTurn('user', [piText('先看看导入')]),
      ])
    );
    const source = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'pi');
    expect(source?.sessions[0].title).toContain('先看看导入');
  });

  it('读取时只收 text part，跳过 thinking', () => {
    const file = piSessionFile(tmp, '.pi', '-tmp-demo', 's1');
    fs.writeFileSync(
      file,
      jsonl([
        piHeader(projectPath),
        piTurn('user', [piText('构建挂了')]),
        piTurn('assistant', [{ type: 'thinking', thinking: '想想' }, piText('已修复')]),
      ])
    );
    expect(readExternalSession('pi', file)).toEqual([
      expect.objectContaining({ role: 'user', text: '构建挂了' }),
      expect.objectContaining({ role: 'assistant', text: '已修复' }),
    ]);
  });

  it('oh-my-pi 读取走同一套 v3 解析', () => {
    const file = piSessionFile(tmp, '.omp', '-project-billcom-web', 's1');
    fs.writeFileSync(
      file,
      jsonl([
        piHeader(projectPath),
        piTurn('user', [piText('你好')]),
        piTurn('assistant', [piText('在')]),
      ])
    );
    expect(readExternalSession('oh-my-pi', file).map((m) => m.text)).toEqual(['你好', '在']);
  });

  it('目录名像当前项目但 header cwd 不匹配时不出现', () => {
    const file = piSessionFile(tmp, '.pi', '-tmp-demo', 's1');
    fs.writeFileSync(file, jsonl([piHeader('/tmp/other'), piTurn('user', [piText('hi')])]));
    expect(listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'pi')).toBeUndefined();
  });

  it('损坏的 jsonl 与缺失文件都返回空消息且不抛错', () => {
    const file = piSessionFile(tmp, '.pi', '-tmp-demo', 's1');
    fs.writeFileSync(file, `not-json\n${JSON.stringify(piHeader(projectPath))}\n`);
    expect(readExternalSession('pi', file)).toEqual([]);
    expect(readExternalSession('pi', path.join(path.dirname(file), 'missing.jsonl'))).toEqual([]);
  });
});

const factorySessionFile = (home: string, projectPath: string, id: string) => {
  const dir = path.join(home, '.factory', 'sessions', encodeClaudeProjectDir(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.jsonl`);
};

describe('Factory 会话', () => {
  const projectPath = '/tmp/demo';

  it('列出会话时给出 Factory 来源、jsonl 路径与 session_start 标题', () => {
    const file = factorySessionFile(tmp, projectPath, 'u-1');
    fs.writeFileSync(
      file,
      jsonl([
        { type: 'session_start', title: '排查构建失败', cwd: projectPath },
        piTurn('user', [piText('hi')]),
      ])
    );
    const source = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'factory');
    expect(source?.sourceName).toBe('Factory');
    expect(source?.sessions.map((s) => s.path)).toEqual([file]);
    expect(source?.sessions[0].title).toBe('排查构建失败');
  });

  it('读取时提取 user/assistant 文本轮次', () => {
    const file = factorySessionFile(tmp, projectPath, 'u-1');
    fs.writeFileSync(
      file,
      jsonl([
        { type: 'session_start', title: '排查构建失败', cwd: projectPath },
        piTurn('user', [piText('构建挂了')]),
        piTurn('assistant', [piText('已修复')]),
      ])
    );
    expect(readExternalSession('factory', file)).toEqual([
      expect.objectContaining({ role: 'user', text: '构建挂了' }),
      expect.objectContaining({ role: 'assistant', text: '已修复' }),
    ]);
  });

  it('跳过以尖括号标签开头的 user 噪声', () => {
    const file = factorySessionFile(tmp, projectPath, 'u-1');
    fs.writeFileSync(
      file,
      jsonl([
        { type: 'session_start', title: 't', cwd: projectPath },
        piTurn('user', [piText('<system-reminder>噪声</system-reminder>')]),
        piTurn('assistant', [piText('收到')]),
      ])
    );
    expect(readExternalSession('factory', file)).toEqual([
      expect.objectContaining({ role: 'assistant', text: '收到' }),
    ]);
  });

  it('损坏的 jsonl 与缺失文件都返回空消息且不抛错', () => {
    const file = factorySessionFile(tmp, projectPath, 'u-1');
    fs.writeFileSync(file, 'not-json\n{"type":"session_start","title":"t"}\n');
    expect(readExternalSession('factory', file)).toEqual([]);
    expect(readExternalSession('factory', path.join(path.dirname(file), 'x.jsonl'))).toEqual([]);
  });

  it('只列出当前项目编码目录下的会话', () => {
    const mine = factorySessionFile(tmp, projectPath, 'u-1');
    fs.writeFileSync(
      mine,
      jsonl([
        { type: 'session_start', title: 'a', cwd: projectPath },
        piTurn('user', [piText('a')]),
      ])
    );
    const other = factorySessionFile(tmp, '/tmp/other', 'u-2');
    fs.writeFileSync(
      other,
      jsonl([
        { type: 'session_start', title: 'b', cwd: '/tmp/other' },
        piTurn('user', [piText('b')]),
      ])
    );
    const source = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'factory');
    expect(source?.sessions.map((s) => s.path)).toEqual([mine]);
  });
});

const writeJsonFile = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};

/** 铺一个 OpenCode 会话，返回 session 元数据 json 绝对路径 */
const seedOpencodeSession = (
  home: string,
  opts: {
    projectId: string;
    worktree: string;
    sessionId: string;
    title: string;
    parentID?: string;
    turns?: { role: string; parts: { type: string; text?: string }[] }[];
  }
) => {
  const storage = path.join(home, '.local', 'share', 'opencode', 'storage');
  writeJsonFile(path.join(storage, 'project', `${opts.projectId}.json`), {
    id: opts.projectId,
    worktree: opts.worktree,
  });
  const sessionFile = path.join(storage, 'session', opts.projectId, `${opts.sessionId}.json`);
  writeJsonFile(sessionFile, {
    id: opts.sessionId,
    directory: opts.worktree,
    title: opts.title,
    time: { updated: 1_700_000_000_000 },
    ...(opts.parentID ? { parentID: opts.parentID } : {}),
  });
  (opts.turns ?? []).forEach((turn, i) => {
    const messageId = `m${i + 1}`;
    writeJsonFile(path.join(storage, 'message', opts.sessionId, `${messageId}.json`), {
      id: messageId,
      role: turn.role,
      time: { created: 1_700_000_000_000 + i },
    });
    turn.parts.forEach((part, j) => {
      writeJsonFile(path.join(storage, 'part', messageId, `p${j + 1}.json`), {
        id: `p${j + 1}`,
        ...part,
      });
    });
  });
  return sessionFile;
};

describe('OpenCode 会话', () => {
  const projectPath = '/tmp/demo';

  it('列出 worktree 匹配的会话，path 是 session 元数据 json', () => {
    const sessionFile = seedOpencodeSession(tmp, {
      projectId: 'prj1',
      worktree: projectPath,
      sessionId: 'ses1',
      title: '排查构建失败',
      turns: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    });
    const source = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'opencode');
    expect(source?.sourceName).toBe('OpenCode');
    expect(source?.sessions.map((s) => s.path)).toEqual([sessionFile]);
    expect(source?.sessions[0].title).toBe('排查构建失败');
  });

  it('读取时按 message 拼接其 text part，跳过非文本 part', () => {
    const sessionFile = seedOpencodeSession(tmp, {
      projectId: 'prj1',
      worktree: projectPath,
      sessionId: 'ses1',
      title: 't',
      turns: [
        { role: 'user', parts: [{ type: 'text', text: '构建挂了' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'step-start' },
            { type: 'text', text: '已修复' },
            { type: 'tool', text: '不该出现' },
          ],
        },
      ],
    });
    expect(readExternalSession('opencode', sessionFile)).toEqual([
      expect.objectContaining({ role: 'user', text: '构建挂了' }),
      expect.objectContaining({ role: 'assistant', text: '已修复' }),
    ]);
  });

  it('带 parentID 的子会话不出现在列表', () => {
    const parent = seedOpencodeSession(tmp, {
      projectId: 'prj1',
      worktree: projectPath,
      sessionId: 'ses1',
      title: '父会话',
      turns: [{ role: 'user', parts: [{ type: 'text', text: 'a' }] }],
    });
    seedOpencodeSession(tmp, {
      projectId: 'prj1',
      worktree: projectPath,
      sessionId: 'ses2',
      title: '子会话',
      parentID: 'ses1',
      turns: [{ role: 'user', parts: [{ type: 'text', text: 'b' }] }],
    });
    const source = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'opencode');
    expect(source?.sessions.map((s) => s.path)).toEqual([parent]);
  });

  it('另一个 worktree 的项目不出现', () => {
    const mine = seedOpencodeSession(tmp, {
      projectId: 'prj1',
      worktree: projectPath,
      sessionId: 'ses1',
      title: '本项目',
      turns: [{ role: 'user', parts: [{ type: 'text', text: 'a' }] }],
    });
    seedOpencodeSession(tmp, {
      projectId: 'prj2',
      worktree: '/tmp/other',
      sessionId: 'ses9',
      title: '其他项目',
      turns: [{ role: 'user', parts: [{ type: 'text', text: 'b' }] }],
    });
    const source = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'opencode');
    expect(source?.sessions.map((s) => s.path)).toEqual([mine]);
  });

  it('损坏的 session json 与缺失文件都返回空消息且不抛错', () => {
    const storage = path.join(tmp, '.local', 'share', 'opencode', 'storage');
    const broken = path.join(storage, 'session', 'prj1', 'bad.json');
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, '{not json');
    expect(readExternalSession('opencode', broken)).toEqual([]);
    expect(
      readExternalSession('opencode', path.join(storage, 'session', 'prj1', 'x.json'))
    ).toEqual([]);
  });
});

const geminiChatFile = (home: string, id: string, name: string) => {
  const dir = path.join(home, '.gemini', 'tmp', id, 'chats');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
};

const geminiHash = (projectPath: string) =>
  crypto.createHash('sha256').update(projectPath).digest('hex');

describe('Gemini CLI 会话', () => {
  const projectPath = '/tmp/demo';
  const geminiTurns = jsonl([
    { type: 'user', content: '构建挂了' },
    { type: 'assistant', content: [{ type: 'text', text: '已修复' }] },
  ]);

  it('projects.json 的 slug 目录下有 session 时列出 Gemini CLI 来源', () => {
    writeJsonFile(path.join(tmp, '.gemini', 'projects.json'), {
      projects: { [projectPath]: 'demo-slug' },
    });
    const file = geminiChatFile(tmp, 'demo-slug', 'session-a.jsonl');
    fs.writeFileSync(file, geminiTurns);
    const source = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'gemini-cli');
    expect(source?.sourceName).toBe('Gemini CLI');
    expect(source?.sessions.map((s) => s.path)).toEqual([file]);
    expect(source?.sessions[0].title).toContain('构建挂了');
  });

  it('没有 projects.json 时认 sha256 哈希目录', () => {
    const file = geminiChatFile(tmp, geminiHash(projectPath), 'session-b.jsonl');
    fs.writeFileSync(file, geminiTurns);
    const source = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'gemini-cli');
    expect(source?.sessions.map((s) => s.path)).toEqual([file]);
  });

  it('读取时把 string 与 text parts 两种 content 都转成文本轮次', () => {
    const file = geminiChatFile(tmp, geminiHash(projectPath), 'session-b.jsonl');
    fs.writeFileSync(file, geminiTurns);
    expect(readExternalSession('gemini-cli', file)).toEqual([
      expect.objectContaining({ role: 'user', text: '构建挂了' }),
      expect.objectContaining({ role: 'assistant', text: '已修复' }),
    ]);
  });

  it('kind 为 subagent 的会话文件不出现在列表', () => {
    const hash = geminiHash(projectPath);
    const normal = geminiChatFile(tmp, hash, 'session-a.jsonl');
    fs.writeFileSync(normal, geminiTurns);
    writeJsonFile(geminiChatFile(tmp, hash, 'session-sub.json'), {
      sessionId: 'sub',
      kind: 'subagent',
      messages: [{ type: 'user', content: '子代理' }],
    });
    const source = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'gemini-cli');
    expect(source?.sessions.map((s) => s.path)).toEqual([normal]);
  });

  it('只有 .project_root 而没有 chats 时该来源不出现', () => {
    writeJsonFile(path.join(tmp, '.gemini', 'projects.json'), {
      projects: { [projectPath]: 'demo-slug' },
    });
    const dir = path.join(tmp, '.gemini', 'tmp', 'demo-slug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.project_root'), projectPath);
    expect(
      listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'gemini-cli')
    ).toBeUndefined();
  });

  it('损坏的 jsonl 与缺失文件都返回空消息且不抛错', () => {
    const file = geminiChatFile(tmp, geminiHash(projectPath), 'session-bad.jsonl');
    fs.writeFileSync(file, 'not-json\n{"type":"system"}\n');
    expect(readExternalSession('gemini-cli', file)).toEqual([]);
    expect(
      readExternalSession('gemini-cli', path.join(path.dirname(file), 'session-x.jsonl'))
    ).toEqual([]);
  });

  it('其他项目的 slug 与哈希目录不出现', () => {
    writeJsonFile(path.join(tmp, '.gemini', 'projects.json'), {
      projects: { [projectPath]: 'demo-slug', '/tmp/other': 'other-slug' },
    });
    const mine = geminiChatFile(tmp, 'demo-slug', 'session-a.jsonl');
    fs.writeFileSync(mine, geminiTurns);
    fs.writeFileSync(geminiChatFile(tmp, 'other-slug', 'session-c.jsonl'), geminiTurns);
    fs.writeFileSync(geminiChatFile(tmp, geminiHash('/tmp/other'), 'session-d.jsonl'), geminiTurns);
    const source = listExternalSessions(projectPath, tmp).find((s) => s.sourceId === 'gemini-cli');
    expect(source?.sessions.map((s) => s.path)).toEqual([mine]);
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
