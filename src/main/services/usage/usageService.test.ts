import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../oauthProviders', () => ({ getRuntime: vi.fn() }));

import { buildPricingTable, loadSessions } from './usageService';

describe('buildPricingTable', () => {
  const full = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  // 真实场景：同一 model id 同时出现在 anthropic（有价）与 github-copilot（订阅计费全零）
  it('同 id 多 provider 时优先四项单价均非零的那条，与出现顺序无关', () => {
    expect(
      buildPricingTable([
        { id: 'm', cost: zero },
        { id: 'm', cost: full },
      ]).m
    ).toEqual(full);
    expect(
      buildPricingTable([
        { id: 'm', cost: full },
        { id: 'm', cost: zero },
      ]).m
    ).toEqual(full);
  });

  it('cost 缺失或不是对象的条目跳过；单项非数值按 0', () => {
    const table = buildPricingTable([
      { id: 'a' },
      { id: 'b', cost: null },
      { id: 'c', cost: { input: 'x' as unknown as number, output: 2 } },
    ]);
    expect(Object.keys(table)).toEqual(['c']);
    expect(table.c).toEqual({ input: 0, output: 2, cacheRead: 0, cacheWrite: 0 });
  });
});

describe('loadSessions', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-usage-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const header = (id: string) =>
    JSON.stringify({ type: 'session', version: 3, id, timestamp: 't', cwd: '/p/demo' });

  it('只读 .jsonl，无 session 头的文件不计', () => {
    fs.writeFileSync(path.join(tmp, 'a.jsonl'), `${header('s1')}\n`);
    fs.writeFileSync(path.join(tmp, 'b.jsonl'), '{"type":"message"}\n');
    fs.writeFileSync(path.join(tmp, 'c.txt'), header('s3'));
    expect(loadSessions(tmp).map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('文件内容变化（mtime/size 改变）后重新解析，删除后不再出现', () => {
    const file = path.join(tmp, 'a.jsonl');
    fs.writeFileSync(file, `${header('s1')}\n`);
    expect(loadSessions(tmp)[0]?.sessionId).toBe('s1');
    fs.writeFileSync(file, `${header('s1-renamed')}\n`);
    fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(loadSessions(tmp)[0]?.sessionId).toBe('s1-renamed');
    fs.rmSync(file);
    expect(loadSessions(tmp)).toEqual([]);
  });

  it('目录不存在时返回空数组而不抛错', () => {
    expect(loadSessions(path.join(tmp, 'missing'))).toEqual([]);
  });
});
