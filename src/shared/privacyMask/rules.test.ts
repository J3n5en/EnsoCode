import { describe, expect, it } from 'vitest';
import { compileRules, findSpans } from './rules';
import { DEFAULT_PRIVACY_MASK_SETTINGS, type PrivacyMaskSettings } from './settings';

const on = (patch: Partial<PrivacyMaskSettings> = {}): PrivacyMaskSettings => ({
  ...DEFAULT_PRIVACY_MASK_SETTINGS,
  enabled: true,
  secrets: { enabled: true, action: 'mask', shape: false },
  personal: { enabled: true, action: 'mask', kinds: ['email', 'phone', 'idCard', 'bankCard'] },
  ...patch,
});
const values = (text: string, settings = on()) =>
  findSpans(text, compileRules(settings)).map((s) => [s.kind, text.slice(s.start, s.end)]);

const OPENAI = 'sk-proj-AbCdEfGh1234567890IjKlMnOp';

describe('privacy mask rules', () => {
  it('finds vendor keys without eating neighbours', () => {
    expect(values(`key=${OPENAI}.`)).toEqual([['API_KEY', OPENAI]]);
    expect(values('ghp_abcdefghijklmnopqrstuvwxyz0123456789 and AKIAABCDEFGHIJKLMNOP')).toEqual([
      ['API_KEY', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
      ['API_KEY', 'AKIAABCDEFGHIJKLMNOP'],
    ]);
  });

  it('does not match ordinary words with key-like prefixes', () => {
    expect(values('task-runner sk-short desk-lamp AKIA')).toEqual([]);
  });

  it('masks only the value of key/value pairs, url passwords and bearer tokens', () => {
    expect(values('DB_PASSWORD="hunter2hunter2"')).toEqual([['PASSWORD', 'hunter2hunter2']]);
    expect(values('postgres://admin:s3cretPass@db:5432/x')).toEqual([['PASSWORD', 's3cretPass']]);
    expect(values('Authorization: Bearer abcdefghijklmnop1234')).toEqual([
      ['TOKEN', 'abcdefghijklmnop1234'],
    ]);
    expect(values('数据库密码：Zx9!kq77')).toEqual([['PASSWORD', 'Zx9!kq77']]);
  });

  it('ignores env references and empty-ish values', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 测试 env 引用原文
    expect(values('api_key: ${OPENAI_KEY}\npassword = null\ntoken: <your-token>')).toEqual([]);
  });

  it('catches PEM private keys as a whole block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    expect(values(`x ${pem} y`)).toEqual([['PRIVATE_KEY', pem]]);
  });

  it('validates personal data', () => {
    expect(values('mail bob@corp.io or noreply@corp.io or a@example.com')).toEqual([
      ['EMAIL', 'bob@corp.io'],
    ]);
    expect(values('call 13812345678 not 12812345678 or 138123456789')).toEqual([
      ['PHONE', '13812345678'],
    ]);
    expect(values('id 11010519491231002X bad 110105194912310021')).toEqual([
      ['ID_CARD', '11010519491231002X'],
    ]);
    expect(values('card 4111 1111 1111 1111 vs 4111111111111112')).toEqual([
      ['BANK_CARD', '4111 1111 1111 1111'],
    ]);
  });

  it('respects category switches and personal kinds', () => {
    const s = on({ personal: { enabled: true, action: 'mask', kinds: ['phone'] } });
    expect(values('bob@corp.io 13812345678', s)).toEqual([['PHONE', '13812345678']]);
    expect(
      values(OPENAI, on({ secrets: { enabled: false, action: 'mask', shape: false } }))
    ).toEqual([]);
  });

  it('supports custom words, prefixes and regex; invalid regex is ignored', () => {
    const s = on({
      custom: {
        words: ['Project Falcon', 'acme'],
        rules: ['corp_', '/INC-\\d{4}/', '/(/'],
        action: 'mask',
      },
    });
    expect(values('project falcon at Acme, acmeX, corp_9f8e7d, INC-2024', s)).toEqual([
      ['CUSTOM', 'project falcon'],
      ['CUSTOM', 'Acme'],
      ['CUSTOM', 'corp_9f8e7d'],
      ['CUSTOM', 'INC-2024'],
    ]);
  });

  it('skips allowed values and existing placeholders', () => {
    const s = on({ allow: ['Bob@Corp.io'], custom: { words: ['API'], rules: [], action: 'mask' } });
    expect(values('bob@corp.io {{API_KEY_abcdefgh}}', s)).toEqual([]);
  });

  it('carries action per category', () => {
    const s = on({ personal: { enabled: true, action: 'warn', kinds: ['email'] } });
    const spans = findSpans(`bob@corp.io ${OPENAI}`, compileRules(s));
    expect(spans.map((x) => x.action)).toEqual(['warn', 'mask']);
  });

  // 审计复现：开启脱敏后每次请求都对 tool_result 全量执行；url 规则的 scheme 从长串里每个词首起
  // 都要扫到串尾，二次复杂度，200KB 的 `a.a.…` 要 9.8 秒
  it('超长的点分串不会让脱敏卡住', () => {
    const text = 'a.'.repeat(40_000);
    const started = performance.now();
    expect(values(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(200);
  });

  // 同上：kv 规则的 key 前缀 `(?:[A-Za-z0-9]+[_-])*` 也逐个词首重扫，200KB 的 `a-a-…` 要 34 秒
  it('超长的连字符串不会让脱敏卡住', () => {
    const text = 'a-'.repeat(20_000);
    const started = performance.now();
    expect(values(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('限制匹配起点后，原本能遮的 key 前缀与 scheme 写法一个不漏', () => {
    expect(values('--password=hunter2hunter2')).toEqual([['PASSWORD', 'hunter2hunter2']]);
    expect(values('__db-password=hunter2hunter2')).toEqual([['PASSWORD', 'hunter2hunter2']]);
    expect(values('-postgres://admin:s3cretPass@db')).toEqual([['PASSWORD', 's3cretPass']]);
    expect(values('x_y.postgres://admin:s3cretPass@db')).toEqual([['PASSWORD', 's3cretPass']]);
  });
});
