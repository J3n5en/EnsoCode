import { describe, expect, it } from 'vitest';
import { parseSshConnection } from './ssh';

const id = '11111111-1111-4111-8111-111111111111';

describe('parseSshConnection', () => {
  it('公开投影:无密码明文,hasPassword 布尔', () => {
    const conn = {
      id,
      name: 'prod',
      host: '23.1.2.3',
      user: 'root',
      port: 22,
      auth: 'key' as const,
      hasPassword: false,
    };
    expect(parseSshConnection(conn)).toEqual(conn);
    expect(
      parseSshConnection({
        id,
        name: 'pw',
        host: 'box',
        auth: 'password',
        hasPassword: true,
      })
    ).not.toBeNull();
  });

  it('脏输入拒绝:缺字段、非法 auth、带 password 明文、坏 uuid', () => {
    expect(
      parseSshConnection({ name: 'x', host: 'h', auth: 'key', hasPassword: false })
    ).toBeNull();
    expect(
      parseSshConnection({ id, name: 'x', host: 'h', auth: 'token', hasPassword: false })
    ).toBeNull();
    expect(
      parseSshConnection({
        id,
        name: 'x',
        host: 'h',
        auth: 'password',
        hasPassword: true,
        password: 'leak',
      })
    ).toBeNull();
    expect(
      parseSshConnection({ id: 'bad', name: 'x', host: 'h', auth: 'key', hasPassword: false })
    ).toBeNull();
    expect(parseSshConnection(null)).toBeNull();
  });
});
