import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateSkillTokens, estimateToolsTotal } from '@shared/occupancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  occupancyForBuiltinTools,
  occupancyForInstructions,
  occupancyForMcp,
  occupancyForSkills,
  parseOccupancyIds,
} from './assetOccupancy';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-occ-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseOccupancyIds', () => {
  it('只收非空字符串', () => {
    expect(parseOccupancyIds(['a', '', 1, null, 'b'])).toEqual(['a', 'b']);
    expect(parseOccupancyIds('nope')).toEqual([]);
  });
});

describe('occupancyForBuiltinTools', () => {
  it('按开关 id 汇总 tool schema', () => {
    expect(
      occupancyForBuiltinTools({
        todo: [{ name: 'todo', description: 'abcd', parameters: {} }],
      })
    ).toEqual([
      {
        id: 'todo',
        tokens: estimateToolsTotal([{ name: 'todo', description: 'abcd', parameters: {} }]),
        toolCount: 1,
      },
    ]);
  });
});

describe('occupancyForSkills', () => {
  it('按 id 读 SKILL.md，未知 id / 缺文件为 null', () => {
    const skillDir = path.join(tmp, 'cloudflare');
    fs.mkdirSync(skillDir);
    const content = '---\nname: cloudflare\n---\n\nbody';
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
    const rows = occupancyForSkills(
      ['ok', 'missing-file', 'unknown'],
      [
        {
          id: 'ok',
          name: 'cloudflare',
          description: 'cf',
          path: skillDir,
          source: 'test',
          enabled: true,
        },
        {
          id: 'missing-file',
          name: 'gone',
          description: '',
          path: path.join(tmp, 'nope'),
          source: 'test',
          enabled: true,
        },
      ]
    );
    expect(rows).toEqual([
      {
        id: 'ok',
        tokens: estimateSkillTokens({ name: 'cloudflare', description: 'cf', content }),
      },
      { id: 'missing-file', tokens: null },
      { id: 'unknown', tokens: null },
    ]);
  });

  it('不采信 catalog 以外的路径，只按 id 解析', () => {
    const rows = occupancyForSkills(['../etc'], []);
    expect(rows).toEqual([{ id: '../etc', tokens: null }]);
  });
});

describe('occupancyForInstructions', () => {
  it('读正文估算；失败为 null', () => {
    const rows = occupancyForInstructions(['a', 'b', 'c'], (id) => {
      if (id === 'a') return { ok: true, content: 'abcd' };
      if (id === 'b') return { ok: false, content: '', error: 'No source' };
      return null;
    });
    expect(rows).toEqual([
      { id: 'a', tokens: 1 },
      { id: 'b', tokens: null, error: 'No source' },
      { id: 'c', tokens: null },
    ]);
  });
});

describe('occupancyForMcp', () => {
  it('未启用不探测；启用求和；单失败不拖垮', async () => {
    const listTools = vi.fn(async (server: { name: string }) => {
      if (server.name === 'bad') throw new Error('boom');
      return [{ name: 't', description: 'd', parameters: { type: 'object' } }];
    });
    const rows = await occupancyForMcp(
      ['on', 'off', 'bad', 'ghost'],
      [
        {
          id: 'on',
          name: 'on',
          transport: 'stdio',
          command: 'echo',
          source: 'test',
          enabled: true,
        },
        {
          id: 'off',
          name: 'off',
          transport: 'stdio',
          command: 'echo',
          source: 'test',
          enabled: false,
        },
        {
          id: 'bad',
          name: 'bad',
          transport: 'stdio',
          command: 'echo',
          source: 'test',
          enabled: true,
        },
      ],
      listTools
    );
    const expected = estimateToolsTotal([
      { name: 't', description: 'd', parameters: { type: 'object' } },
    ]);
    expect(rows).toEqual([
      { id: 'on', tokens: expected, toolCount: 1 },
      { id: 'off', tokens: null },
      { id: 'bad', tokens: null, error: 'boom' },
      { id: 'ghost', tokens: null },
    ]);
    expect(listTools.mock.calls.map((call) => call[0].name)).toEqual(['on', 'bad']);
  });
});
