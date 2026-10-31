import { describe, expect, it } from 'vitest';
import { parseControlCommand } from './control';

describe('parseControlCommand', () => {
  it('accepts pair and devices', () => {
    expect(parseControlCommand('{"cmd":"pair"}')).toEqual({ cmd: 'pair' });
    expect(parseControlCommand('{"cmd":"devices"}')).toEqual({ cmd: 'devices' });
    expect(parseControlCommand('{"cmd":"update"}')).toEqual({ cmd: 'update' });
    expect(parseControlCommand('{"cmd":"status"}')).toEqual({ cmd: 'status' });
  });

  it('requires an id to revoke', () => {
    expect(parseControlCommand('{"cmd":"revoke","id":" dev "}')).toEqual({
      cmd: 'revoke',
      id: 'dev',
    });
    expect(parseControlCommand('{"cmd":"revoke"}')).toEqual({ error: 'revoke requires id' });
  });

  it('rejects unknown input', () => {
    expect(parseControlCommand('nope')).toEqual({ error: 'invalid json' });
    expect(parseControlCommand('{"cmd":"quit"}')).toEqual({ error: 'unknown command' });
  });

  it('插件命令：按动作校验参数', () => {
    const parse = (v: unknown) => parseControlCommand(JSON.stringify(v));
    expect(parse({ cmd: 'plugin', action: 'list' })).toEqual({ cmd: 'plugin', action: 'list' });
    expect(parse({ cmd: 'plugin', action: 'stage', path: '/srv/p.zip' })).toEqual({
      cmd: 'plugin',
      action: 'stage',
      path: '/srv/p.zip',
    });
    expect(parse({ cmd: 'plugin', action: 'stage', path: 'rel/p' })).toEqual({
      error: 'plugin stage requires an absolute path',
    });
    expect(parse({ cmd: 'plugin', action: 'stage', url: 'https://example.com/a.zip' })).toEqual({
      cmd: 'plugin',
      action: 'stage',
      url: 'https://example.com/a.zip',
    });
    expect(parse({ cmd: 'plugin', action: 'stage', url: 'file:///tmp/a.zip' })).toEqual({
      error: 'plugin stage url must be http or https',
    });
    expect(
      parse({
        cmd: 'plugin',
        action: 'stage',
        path: '/srv/p.zip',
        url: 'https://example.com/a.zip',
      })
    ).toEqual({
      error: 'plugin stage requires an absolute path or an http(s) url',
    });
    expect(parse({ cmd: 'plugin', action: 'commit', token: 't1' })).toEqual({
      cmd: 'plugin',
      action: 'commit',
      token: 't1',
    });
    expect(parse({ cmd: 'plugin', action: 'enable', id: 'a.b' })).toEqual({
      cmd: 'plugin',
      action: 'enable',
      id: 'a.b',
    });
    expect(parse({ cmd: 'plugin', action: 'enable' })).toEqual({
      error: 'plugin enable requires id',
    });
    expect(parse({ cmd: 'plugin', action: 'explode' })).toEqual({ error: 'unknown plugin action' });
  });

  it('插件配置命令：config-get 要 id，config-set 的值只能是字符串或 null', () => {
    const parse = (v: unknown) => parseControlCommand(JSON.stringify(v));
    expect(parse({ cmd: 'plugin', action: 'config-get', id: 'a.b' })).toEqual({
      cmd: 'plugin',
      action: 'config-get',
      id: 'a.b',
    });
    expect(
      parse({ cmd: 'plugin', action: 'config-set', id: 'a.b', values: { k: 'v', t: null } })
    ).toEqual({ cmd: 'plugin', action: 'config-set', id: 'a.b', values: { k: 'v', t: null } });
    expect(parse({ cmd: 'plugin', action: 'config-set', id: 'a.b', values: { k: 1 } })).toEqual({
      error: 'plugin config-set requires id and string values',
    });
    expect(parse({ cmd: 'plugin', action: 'config-set', values: {} })).toEqual({
      error: 'plugin config-set requires id and string values',
    });
  });
});
