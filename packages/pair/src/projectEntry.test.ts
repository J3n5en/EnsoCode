import { describe, expect, it } from 'vitest';
import { pairProjectListLabel, sshProjectLabel, toPairProjectEntry } from './projectEntry';

describe('toPairProjectEntry', () => {
  it('本地项目不下发 ssh 字段', () => {
    expect(toPairProjectEntry({ id: '1', name: 'app', path: '/tmp/app', kind: 'local' })).toEqual({
      id: '1',
      name: 'app',
      path: '/tmp/app',
    });
  });

  it('ssh 项目带连接名与 host', () => {
    expect(
      toPairProjectEntry({
        id: '1',
        name: 'app',
        path: '/srv/app',
        kind: 'ssh',
        sshConnectionName: 'prod',
        sshHost: 'root@example',
      })
    ).toEqual({
      id: '1',
      name: 'app',
      path: '/srv/app',
      kind: 'ssh',
      sshConnectionName: 'prod',
      sshHost: 'root@example',
    });
  });
});

describe('sshProjectLabel', () => {
  it('优先连接名，否则 host，非 ssh 无徽标', () => {
    expect(sshProjectLabel({ kind: 'ssh', sshConnectionName: 'prod', sshHost: 'h' })).toBe('prod');
    expect(sshProjectLabel({ kind: 'ssh', sshHost: 'root@box' })).toBe('root@box');
    expect(sshProjectLabel({ kind: 'local' })).toBeUndefined();
  });
});

describe('pairProjectListLabel', () => {
  it('同名时用括号带上连接名', () => {
    expect(
      pairProjectListLabel({
        id: '1',
        name: 'app',
        path: '/srv/app',
        kind: 'ssh',
        sshConnectionName: 'prod',
      })
    ).toBe('app (prod)');
    expect(pairProjectListLabel({ id: '2', name: 'app', path: '/tmp/app' })).toBe('app');
  });
});
