import { describe, expect, it } from 'vitest';
import { grantExpands, type PluginGrant } from './grant';

const grant = (patch: Partial<PluginGrant> = {}): PluginGrant => ({
  permissions: ['agent.tool', 'fs.read', 'net.fetch', 'mcp.server'],
  fsRead: ['docs'],
  fsWrite: [],
  netDomains: ['api.example.com'],
  mcp: [{ name: 'demo', command: 'node', args: ['server.js'], envKeys: [] }],
  mcpTools: ['search_context'],
  renderer: false,
  env: [],
  interop: [],
  intercepts: [],
  resident: false,
  styles: false,
  ...patch,
});

describe('grantExpands', () => {
  it('完全相同不算扩大', () => {
    expect(grantExpands(grant(), grant())).toBe(false);
  });

  it('删掉权限、缩小范围不算扩大', () => {
    expect(
      grantExpands(
        grant(),
        grant({ permissions: ['agent.tool'], fsRead: [], netDomains: [], mcp: [], mcpTools: [] })
      )
    ).toBe(false);
    expect(grantExpands(grant(), grant({ fsRead: ['docs/api'] }))).toBe(false);
    expect(grantExpands(grant({ styles: true }), grant())).toBe(false);
  });

  it.each<[string, Partial<PluginGrant>]>([
    ['新增权限', { permissions: ['agent.tool', 'fs.read', 'net.fetch', 'mcp.server', 'fs.write'] }],
    ['只加一个域名', { netDomains: ['api.example.com', 'evil.example.com'] }],
    ['fs 变宽', { fsRead: ['.'] }],
    ['fs 换成兄弟目录', { fsRead: ['docs2'] }],
    [
      '只改 MCP 命令',
      { mcp: [{ name: 'demo', command: 'bash', args: ['server.js'], envKeys: [] }] },
    ],
    [
      '只改 MCP 参数',
      { mcp: [{ name: 'demo', command: 'node', args: ['other.js'], envKeys: [] }] },
    ],
    [
      'MCP 新增 env 键',
      { mcp: [{ name: 'demo', command: 'node', args: ['server.js'], envKeys: ['TOKEN'] }] },
    ],
    ['新增 renderer', { renderer: true }],
    ['可调用的 MCP 工具变多', { mcpTools: ['search_context', 'enhance_prompt'] }],
    ['新增透传环境变量', { env: ['JAVA_HOME'] }],
    ['新增可调用的插件', { interop: ['other.plugin'] }],
    ['新增拦截事件', { intercepts: ['tool_call'] }],
    ['改为常驻', { resident: true }],
    ['主题开始带 CSS', { styles: true }],
  ])('%s 算扩大', (_label, patch) => {
    expect(grantExpands(grant(), grant(patch))).toBe(true);
  });
});
