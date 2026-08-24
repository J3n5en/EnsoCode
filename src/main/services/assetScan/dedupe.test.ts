import { describe, expect, it } from 'vitest';
import { mcpKey, skillNameKey } from './index';
import type { DiscoveredMcpServer } from './mcp';

describe('skillNameKey', () => {
  it('大小写与空白不影响身份', () => {
    expect(skillNameKey('Cloudflare')).toBe('cloudflare');
    expect(skillNameKey('  wrangler  ')).toBe('wrangler');
    expect(skillNameKey('AGENTS-SDK')).toBe(skillNameKey('agents-sdk'));
  });

  it('同一技能被多个工具各装一份时视为同一个', () => {
    // 真实场景：~/.claude/skills、~/.codex/skills、~/.cursor/skills 下
    // 各有一份内容完全相同的 cloudflare 技能，路径不同但应判为重复
    const fromClaude = skillNameKey('cloudflare');
    const fromCodex = skillNameKey('cloudflare');
    const fromCursor = skillNameKey('cloudflare');
    expect(new Set([fromClaude, fromCodex, fromCursor]).size).toBe(1);
  });

  it('不同技能不会相撞', () => {
    expect(skillNameKey('cloudflare')).not.toBe(skillNameKey('cloudflare-one'));
  });
});

describe('mcpKey', () => {
  const stdio = (over: Partial<DiscoveredMcpServer> = {}): DiscoveredMcpServer => ({
    name: 'semble',
    transport: 'stdio',
    command: 'uvx',
    args: ['--from', 'semble[mcp]', 'semble'],
    ...over,
  });

  it('stdio 用命令加参数作为身份，与名称无关', () => {
    // 真实场景：同一个服务器在 Claude 里叫 cunzhi，在 Cursor 里叫寸止
    const a = mcpKey({ name: 'cunzhi', transport: 'stdio', command: '寸止' });
    const b = mcpKey({ name: '寸止', transport: 'stdio', command: '寸止' });
    expect(a).toBe(b);
  });

  it('参数不同即不同服务器', () => {
    expect(mcpKey(stdio())).not.toBe(mcpKey(stdio({ args: ['--from', 'other', 'x'] })));
  });

  it('缺省 args 与空 args 等价', () => {
    expect(mcpKey({ name: 'x', transport: 'stdio', command: 'foo' })).toBe(
      mcpKey({ name: 'x', transport: 'stdio', command: 'foo', args: [] })
    );
  });

  it('有 url 时优先用 url，且忽略末尾斜杠', () => {
    const a = mcpKey({ name: 'grep', transport: 'http', url: 'https://mcp.grep.app' });
    const b = mcpKey({ name: 'grep2', transport: 'http', url: 'https://mcp.grep.app///' });
    expect(a).toBe(b);
    expect(a.startsWith('url::')).toBe(true);
  });

  it('url 与 stdio 的指纹不会混淆', () => {
    const url = mcpKey({ name: 'x', transport: 'http', url: 'https://example.com' });
    const cmd = mcpKey({ name: 'x', transport: 'stdio', command: 'https://example.com' });
    expect(url).not.toBe(cmd);
  });
});
