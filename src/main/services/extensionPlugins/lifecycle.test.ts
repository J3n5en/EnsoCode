import type { PluginGrant } from '@shared/extensionPlugins/grant';
import { describe, expect, it } from 'vitest';
import { applyPluginAction, type PluginRecord } from './lifecycle';

const grant = (permissions: string[] = ['agent.tool']): PluginGrant => ({
  permissions,
  fsRead: [],
  fsWrite: [],
  netDomains: [],
  mcp: [],
  mcpTools: [],
  renderer: false,
  env: [],
  interop: [],
  intercepts: [],
  resident: false,
  styles: false,
});

const record = (patch: Partial<PluginRecord> = {}): PluginRecord => ({
  id: 'example.demo',
  version: '1.0.0',
  dir: 'd1',
  state: 'disabled',
  grant: grant(),
  installedAt: 1,
  crossSessionInject: false,
  ...patch,
});

const ok = (result: ReturnType<typeof applyPluginAction>): PluginRecord => {
  if ('error' in result) throw new Error(result.error);
  return result;
};

describe('applyPluginAction', () => {
  it('停用 ↔ 启用', () => {
    const enabled = ok(applyPluginAction(record(), { type: 'enable' }));
    expect(enabled.state).toBe('enabled');
    expect(ok(applyPluginAction(enabled, { type: 'disable' })).state).toBe('disabled');
  });

  it('只有启用中的插件会进入崩溃停用，用户可重新启用', () => {
    expect('error' in applyPluginAction(record(), { type: 'crash' })).toBe(true);
    const crashed = ok(applyPluginAction(record({ state: 'enabled' }), { type: 'crash' }));
    expect(crashed.state).toBe('crashed');
    expect(ok(applyPluginAction(crashed, { type: 'enable' })).state).toBe('enabled');
  });

  it('更新未扩大授权时直接切换，状态不变', () => {
    const next = ok(
      applyPluginAction(record({ state: 'enabled' }), {
        type: 'update',
        version: '1.1.0',
        dir: 'd2',
        grant: grant(),
        expands: false,
      })
    );
    expect(next).toMatchObject({ version: '1.1.0', dir: 'd2', state: 'enabled' });
    expect(next.pending).toBeUndefined();
  });

  it('更新扩大授权时挂起，旧版本照常运行；同意后切换', () => {
    const pending = ok(
      applyPluginAction(record({ state: 'enabled' }), {
        type: 'update',
        version: '2.0.0',
        dir: 'd2',
        grant: grant(['agent.tool', 'net.fetch']),
        expands: true,
      })
    );
    expect(pending).toMatchObject({ version: '1.0.0', dir: 'd1', state: 'enabled' });
    expect(pending.pending?.version).toBe('2.0.0');
    const approved = ok(applyPluginAction(pending, { type: 'approve-pending' }));
    expect(approved).toMatchObject({ version: '2.0.0', dir: 'd2', state: 'enabled' });
    expect(approved.grant.permissions).toContain('net.fetch');
    expect(approved.pending).toBeUndefined();
  });

  it('拒绝挂起的更新保留旧版本', () => {
    const pending = ok(
      applyPluginAction(record(), {
        type: 'update',
        version: '2.0.0',
        dir: 'd2',
        grant: grant(['net.fetch']),
        expands: true,
      })
    );
    const rejected = ok(applyPluginAction(pending, { type: 'reject-pending' }));
    expect(rejected).toMatchObject({ version: '1.0.0', dir: 'd1' });
    expect(rejected.pending).toBeUndefined();
  });

  it('没有挂起更新时同意或拒绝报错', () => {
    expect('error' in applyPluginAction(record(), { type: 'approve-pending' })).toBe(true);
    expect('error' in applyPluginAction(record(), { type: 'reject-pending' })).toBe(true);
  });
});
