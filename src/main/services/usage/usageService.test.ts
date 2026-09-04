import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../oauthProviders', () => ({ getRuntime: vi.fn() }));

import { costOf, type PricingTable } from '@shared/usage/pricing';
import { app } from 'electron';
import { getRuntime } from '../oauthProviders';
import {
  buildPricingTable,
  getUsageSummary,
  loadSessions,
  supplementPricingTable,
} from './usageService';

describe('supplementPricingTable', () => {
  it('2027-01-01 UTC 之前使用初次体验价（$0.75/$3.75/M，cacheRead 0.075）', () => {
    const promoTime = Date.parse('2026-12-31T23:59:59.999Z');
    const table = supplementPricingTable({}, promoTime);
    expect(table['gemini-3.8-flash']).toEqual({
      input: 0.75,
      output: 3.75,
      cacheRead: 0.075,
      cacheWrite: 0,
    });
  });

  it('2027-01-01 UTC 起切换为标准价（$1.50/$7.50/M，cacheRead 0.15）', () => {
    const standardTime = Date.parse('2027-01-01T00:00:00.000Z');
    const table = supplementPricingTable({}, standardTime);
    expect(table['gemini-3.8-flash']).toEqual({
      input: 1.5,
      output: 7.5,
      cacheRead: 0.15,
      cacheWrite: 0,
    });
  });

  it('上游目录已存在同 ID 价格时上游优先，不被本地补充覆盖', () => {
    const upstreamTable: PricingTable = {
      'gemini-3.8-flash': { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 },
    };
    const table = supplementPricingTable(upstreamTable, Date.parse('2026-09-04T00:00:00Z'));
    expect(table['gemini-3.8-flash']).toEqual({
      input: 2,
      output: 8,
      cacheRead: 0.2,
      cacheWrite: 0,
    });
  });

  it('原有价格表中的其他模型单价完整保留', () => {
    const existingTable: PricingTable = {
      'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    };
    const table = supplementPricingTable(existingTable, Date.parse('2026-09-04T00:00:00Z'));
    expect(table['claude-opus-5']).toEqual(existingTable['claude-opus-5']);
  });

  it('生产接线：gemini-3.8-flash-high 经思考档位回退计费，gemini-3.8-flash-tiered 仍无价格', () => {
    const promoTime = Date.parse('2026-10-01T00:00:00Z');
    const table = supplementPricingTable({}, promoTime);

    // 1M 输入 + 1M 输出：促销期 input $0.75/M + output $3.75/M = $4.50
    const highCost = costOf(
      {
        model: 'gemini-3.8-flash-high',
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
      },
      table
    );
    expect(highCost).toBeCloseTo(4.5);

    // tiered 不属于思考档位，不能回退基础价，无单价返回 null
    const tieredCost = costOf(
      {
        model: 'gemini-3.8-flash-tiered',
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
      },
      table
    );
    expect(tieredCost).toBeNull();
  });
});

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

  it('只读 .jsonl，无 session 头的文件不计', async () => {
    fs.writeFileSync(path.join(tmp, 'a.jsonl'), `${header('s1')}\n`);
    fs.writeFileSync(path.join(tmp, 'b.jsonl'), '{"type":"message"}\n');
    fs.writeFileSync(path.join(tmp, 'c.txt'), header('s3'));
    expect((await loadSessions(tmp)).map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('文件内容变化（mtime/size 改变）后重新解析，删除后不再出现', async () => {
    const file = path.join(tmp, 'a.jsonl');
    fs.writeFileSync(file, `${header('s1')}\n`);
    expect((await loadSessions(tmp))[0]?.sessionId).toBe('s1');
    fs.writeFileSync(file, `${header('s1-renamed')}\n`);
    fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect((await loadSessions(tmp))[0]?.sessionId).toBe('s1-renamed');
    fs.rmSync(file);
    expect(await loadSessions(tmp)).toEqual([]);
  });

  it('目录不存在时返回空数组而不抛错', async () => {
    expect(await loadSessions(path.join(tmp, 'missing'))).toEqual([]);
  });
});

describe('getUsageSummary — 时间一致性快照', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-usage-summary-'));
    vi.spyOn(app, 'getPath').mockReturnValue(tmp);
    vi.mocked(getRuntime).mockResolvedValue({ getModels: () => [] } as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('单次调用只使用一个时间快照，不因执行期间时间流逝产生 pricing 与聚合区间撕裂', async () => {
    // 构造跨年边界：t1 在 2026-12-31 UTC（促销价期），t2 在 2027-01-01 UTC（标准价期）
    const t1 = Date.parse('2026-12-31T23:59:59.000Z');
    const t2 = Date.parse('2027-01-01T00:00:05.000Z');

    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      calls++;
      return calls === 1 ? t1 : t2;
    });

    // 创建会话目录与包含 gemini-3.8-flash-high 的会话记录（时间在 2026-12-31）
    const sessionsDir = path.join(tmp, 'agent', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const header = {
      type: 'session',
      version: 3,
      id: 's-promo',
      timestamp: new Date(t1).toISOString(),
      cwd: '/p/demo',
    };
    const message = {
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: new Date(t1).toISOString(),
      message: {
        role: 'assistant',
        model: 'gemini-3.8-flash-high',
        provider: 'google-antigravity',
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input: 1_000_000,
          output: 1_000_000,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2_000_000,
        },
        timestamp: t1,
      },
    };
    fs.writeFileSync(
      path.join(sessionsDir, 's-promo.jsonl'),
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`
    );

    const result = await getUsageSummary(1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    // 单次调用若以调用起点 t1 为唯一时间快照：
    // 1) 区间以 t1 当天为基准，该记录落在当天（messages === 1）；若以随后的 t2 聚合，当天已是 2027-01-01，该记录会变成昨天被排除（messages === 0）
    expect(result.summary.totals.messages).toBe(1);
    // 2) 计费使用 t1 时刻的促销价（$4.50），而非撕裂状态下的其它结果
    expect(result.summary.totals.cost).toBeCloseTo(4.5);
  });
});
