import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDcgRuleMemoryStore, dcgRuleMemoryFile } from './dcgRuleMemory';
import type { SecureCodec } from './secureFile';

const roots: string[] = [];
const tempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-dcg-rules-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const RULE = 'core.git:reset-hard';

const fakeCodec = (): SecureCodec => ({
  available: async () => true,
  encrypt: async (text) => Buffer.from(`ENC:${Buffer.from(text, 'utf8').toString('base64')}`),
  decrypt: async (data) => {
    const raw = data.toString('utf8');
    if (!raw.startsWith('ENC:')) throw new Error('tampered');
    return {
      text: Buffer.from(raw.slice(4), 'base64').toString('utf8'),
      reEncrypt: false,
    };
  },
});

const unavailableCodec = (): SecureCodec => ({
  available: async () => false,
  encrypt: async () => {
    throw new Error('unavailable');
  },
  decrypt: async () => {
    throw new Error('unavailable');
  },
});

describe('dcg 规则记忆持久化', () => {
  it('使用钥匙串加密落盘，满 5 次提示，支持单条撤销与全部清除，磁盘不含明文', async () => {
    const root = tempRoot();
    const store = createDcgRuleMemoryStore(root, fakeCodec());
    for (let i = 0; i < 4; i += 1) await store.recordAllow(RULE, '0.16.0');
    expect(await store.recordAllow(RULE, '0.16.0')).toEqual({
      allowCount: 5,
      exempt: false,
      suggestExempt: true,
    });
    expect((await store.exempt(RULE, '0.16.0')).exempt).toBe(true);
    expect(store.activeRules('0.16.0')).toEqual([RULE]);
    expect(store.activeRules('0.17.0')).toEqual([]);
    expect(await store.listExemptions('0.16.0')).toMatchObject([
      { ruleId: RULE, dcgVersion: '0.16.0' },
    ]);
    // 磁盘为密文，不含明文规则 ID
    const onDisk = fs.readFileSync(dcgRuleMemoryFile(root), 'utf8');
    expect(onDisk).not.toContain(RULE);

    // 重启后新实例可正确解密读回
    const reloaded = createDcgRuleMemoryStore(root, fakeCodec());
    await reloaded.ready();
    expect(reloaded.activeRules('0.16.0')).toEqual([RULE]);

    // 单条撤销后豁免失效且计数归零
    expect(await reloaded.revoke(RULE, '0.16.0')).toEqual([]);
    expect(reloaded.activeRules('0.16.0')).toEqual([]);
    expect(await reloaded.readState(RULE, '0.16.0')).toEqual({
      allowCount: 0,
      exempt: false,
      suggestExempt: false,
    });

    await reloaded.clear();
    expect(fs.existsSync(dcgRuleMemoryFile(root))).toBe(false);
  });

  it('模型或外部进程篡改/伪造明文磁盘文件时解密失败，按空表处理（fail-closed）', async () => {
    const root = tempRoot();
    const forged = JSON.stringify({
      allowCounts: { [RULE]: 99 },
      exemptions: { [RULE]: { dcgVersion: '0.16.0', at: 1 } },
    });
    fs.writeFileSync(dcgRuleMemoryFile(root), forged);
    fs.writeFileSync(path.join(root, 'dcg-rules.json'), forged);

    const store = createDcgRuleMemoryStore(root, fakeCodec());
    await store.ready();
    expect(store.activeRules('0.16.0')).toEqual([]);
    expect((await store.readState(RULE, '0.16.0')).allowCount).toBe(0);
  });

  it('钥匙串不可用时不落明文磁盘文件，防外部写入篡改', async () => {
    const root = tempRoot();
    const store = createDcgRuleMemoryStore(root, unavailableCodec());
    for (let i = 0; i < 5; i += 1) await store.recordAllow(RULE, '0.16.0');
    expect((await store.exempt(RULE, '0.16.0')).exempt).toBe(true);
    expect(fs.existsSync(dcgRuleMemoryFile(root))).toBe(false);
    expect(fs.existsSync(path.join(root, 'dcg-rules.json'))).toBe(false);
  });
});
