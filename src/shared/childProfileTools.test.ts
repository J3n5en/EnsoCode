import { describe, expect, it } from 'vitest';
import { childProfileShell, childProfileToolIds } from './childProfileTools';

describe('childProfileToolIds', () => {
  it('父会话关闭 workspace_write 时 all 子代理也不能取得写工具', () => {
    expect(childProfileToolIds('all', { workspaceWrite: false })).toEqual(
      childProfileToolIds('readonly')
    );
  });

  it('apply_patch 的 all 只有 apply_patch，默认带沙箱 exec', () => {
    expect(childProfileToolIds('all')).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'bash',
      'apply_patch',
      'message_main_agent',
      'message_coworker',
      'codemode',
    ]);
    expect(childProfileToolIds('all')).not.toContain('edit');
    expect(childProfileToolIds('all')).not.toContain('write');
  });

  it('replace 用 edit/write，关沙箱并打开探后折叠时名单跟着变', () => {
    expect(
      childProfileToolIds('all', {
        editMode: 'replace',
        isolatedSandbox: false,
        exploreFold: true,
        shell: 'powershell',
      })
    ).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'powershell',
      'edit',
      'write',
      'message_main_agent',
      'message_coworker',
      'explore_mark',
      'explore_fold',
    ]);
  });

  it('readonly 不带 shell 和写工具', () => {
    expect(childProfileToolIds('readonly', { isolatedSandbox: false })).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'message_main_agent',
      'message_coworker',
    ]);
  });
});

describe('childProfileShell', () => {
  it('远程或非 win32 用 bash，本地 win32 默认 powershell', () => {
    expect(childProfileShell({ platform: 'win32', remote: true, preference: 'powershell' })).toBe(
      'bash'
    );
    expect(childProfileShell({ platform: 'darwin', preference: 'powershell' })).toBe('bash');
    expect(childProfileShell({ platform: 'win32' })).toBe('powershell');
    expect(childProfileShell({ platform: 'win32', preference: 'bash' })).toBe('bash');
  });
});
