import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readEnsoAiMcp, readEnsoAiPrompts } from './ensoAi';

const tmpFiles: string[] = [];

function writeTmpJson(data: unknown): string {
  const file = path.join(os.tmpdir(), `enso-asset-test-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  tmpFiles.push(file);
  return file;
}

afterEach(() => {
  for (const file of tmpFiles.splice(0)) fs.rmSync(file, { force: true });
});

function ensoAiSettings(state: Record<string, unknown>): unknown {
  return { 'enso-settings': { state } };
}

describe('readEnsoAiMcp', () => {
  it('解析 stdio 与 http 两种 mcpServers 条目', () => {
    const file = writeTmpJson(
      ensoAiSettings({
        mcpServers: [
          {
            id: 'seq',
            name: 'sequential-thinking',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
            env: { FOO: 'bar' },
            enabled: false,
          },
          {
            id: 'grep',
            name: 'grep',
            transportType: 'http',
            url: 'https://mcp.grep.app',
            enabled: true,
          },
        ],
      })
    );

    expect(readEnsoAiMcp(file)).toEqual([
      {
        name: 'sequential-thinking',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
        env: { FOO: 'bar' },
        url: undefined,
      },
      {
        name: 'grep',
        transport: 'http',
        command: undefined,
        args: undefined,
        env: undefined,
        url: 'https://mcp.grep.app',
      },
    ]);
  });

  it('跳过既无 command 也无 url 的条目；缺失 mcpServers 返回空数组', () => {
    const file = writeTmpJson(ensoAiSettings({ mcpServers: [{ name: 'broken' }] }));
    expect(readEnsoAiMcp(file)).toEqual([]);
    expect(readEnsoAiMcp(writeTmpJson(ensoAiSettings({})))).toEqual([]);
  });
});

describe('readEnsoAiPrompts', () => {
  it('promptPresets 转为无文件来源的指令（含哈希与字节数）', () => {
    const file = writeTmpJson(
      ensoAiSettings({
        promptPresets: [
          { id: 'p1', name: '默认', content: '# CLAUDE.md\n规则内容' },
          { id: 'p2', name: '空的', content: '' },
        ],
      })
    );

    const result = readEnsoAiPrompts(file);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: '默认',
      content: '# CLAUDE.md\n规则内容',
      location: 'EnsoAI · 提示预设',
      bytes: Buffer.byteLength('# CLAUDE.md\n规则内容', 'utf8'),
    });
    expect(result[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result[0].path).toBeUndefined();
  });

  it('缺失 promptPresets 返回空数组', () => {
    expect(readEnsoAiPrompts(writeTmpJson(ensoAiSettings({})))).toEqual([]);
  });
});
