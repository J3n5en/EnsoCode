import { describe, expect, it } from 'vitest';
import {
  pairProjectDisplayName,
  pairProjectListLabel,
  sshProjectLabel,
  toPairProjectEntry,
} from './projectEntry';
import type { ProjectEntry } from './protocol';

describe('toPairProjectEntry', () => {
  it('本地项目不下发 ssh 字段', () => {
    expect(toPairProjectEntry({ id: '1', name: 'app', path: '/tmp/app', kind: 'local' })).toEqual({
      id: '1',
      name: 'app',
      path: '/tmp/app',
    });
  });

  it('别名原样透传，无别名不占字段', () => {
    expect(toPairProjectEntry({ id: '1', name: 'app', path: '/tmp/app', alias: '线上' })).toEqual({
      id: '1',
      name: 'app',
      path: '/tmp/app',
      alias: '线上',
    });
    expect(toPairProjectEntry({ id: '2', name: 'app', path: '/tmp/app', alias: '  ' })).toEqual({
      id: '2',
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

describe('pairProjectDisplayName', () => {
  it('别名优先于项目名', () => {
    expect(pairProjectDisplayName({ name: 'app', alias: '线上' })).toBe('线上');
  });

  it('别名去首尾空白', () => {
    expect(pairProjectDisplayName({ name: 'app', alias: '  线上  ' })).toBe('线上');
  });

  it('别名为空白或缺省时回落项目名', () => {
    expect(pairProjectDisplayName({ name: 'app', alias: '  ' })).toBe('app');
    expect(pairProjectDisplayName({ name: 'app' })).toBe('app');
  });
});

describe('pairProjectListLabel', () => {
  it('别名参与列表标签', () => {
    expect(
      pairProjectListLabel({
        id: '1',
        name: 'app',
        path: '/srv/app',
        alias: '线上',
        kind: 'ssh',
        sshConnectionName: 'prod',
      })
    ).toBe('线上 (prod)');
  });

  // 项目帧下发前被 slimProjectsForPhone 删掉 path，对端拿到的就是这个形状
  it('缺 path 的项目帧照样出别名', () => {
    expect(pairProjectListLabel({ id: '1', name: 'app', alias: '线上' } as ProjectEntry)).toBe(
      '线上'
    );
  });

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
