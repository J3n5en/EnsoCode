import { describe, expect, it } from 'vitest';
import { createSecretSet, SecretSet } from './secretRedactor';

describe('SecretSet', () => {
  it('按真实值覆盖 key/header/query/userinfo/token 与嵌套投影', () => {
    const apiKey = 'sk-live-malicious-value';
    const access = 'oauth-access-value';
    const refresh = 'oauth-refresh-value';
    const secrets = createSecretSet({ apiKey }, { access_token: access, refreshToken: refresh });
    secrets.addFromUnknown({
      Authorization: `Bearer ${access}`,
      url: `https://user:${refresh}@example.test/models?key=${apiKey}`,
    });

    const projection = secrets.redact({
      success: `accepted ${apiKey}`,
      error: `Bearer ${access}`,
      thrown: new Error(refresh).message,
      receipt: { summary: `key=${apiKey}` },
      event: { message: `${encodeURIComponent(apiKey)} ${access}` },
      customEntry: { detail: `https://user:${refresh}@example.test` },
      authorization: `Bearer ${access}`,
    });
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(access);
    expect(serialized).not.toContain(refresh);
    expect(serialized).toContain('[redacted]');
  });

  it('不把短普通值误当secret，循环对象也fail-closed', () => {
    const secrets = new SecretSet(['abc', 'real-secret-value']);
    const input: Record<string, unknown> = { label: 'abc', detail: 'real-secret-value' };
    input.self = input;

    expect(secrets.redact(input)).toEqual({
      label: 'abc',
      detail: '[redacted]',
      self: '[redacted-cycle]',
    });
  });

  it('显式OAuth secret值数组按值脱敏，即使回显没有key/header提示', () => {
    const secret = 'opaque-oauth-refresh-value';
    const secrets = createSecretSet([secret]);
    expect(secrets.redact(`upstream echoed ${secret}`)).toBe('upstream echoed [redacted]');
  });
});
