import { describe, expect, it } from 'vitest';
import { isValidId } from './instructionStore';

describe('isValidId', () => {
  it('接受标准 uuid', () => {
    expect(isValidId('4aade2cb-d2a1-47c3-a4a2-848f28571a97')).toBe(true);
    expect(isValidId('4AADE2CB-D2A1-47C3-A4A2-848F28571A97')).toBe(true);
  });

  it('拒绝路径穿越', () => {
    // 本地副本路径是 userData/instructions/<id>.md，id 不受控就等于可写任意文件
    expect(isValidId('../../../etc/passwd')).toBe(false);
    expect(isValidId('..%2F..%2Fetc')).toBe(false);
    expect(isValidId('a/b')).toBe(false);
    expect(isValidId('/absolute/path')).toBe(false);
  });

  it('拒绝长度不符的字符串', () => {
    expect(isValidId('')).toBe(false);
    expect(isValidId('short')).toBe(false);
    expect(isValidId('4aade2cb-d2a1-47c3-a4a2-848f28571a97-extra')).toBe(false);
  });

  it('拒绝含非十六进制字符的串', () => {
    // 长度对但字符不合法
    expect(isValidId('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).toBe(false);
    expect(isValidId('4aade2cb.d2a1.47c3.a4a2.848f28571a97')).toBe(false);
  });
});
