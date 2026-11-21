import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_RUNNING_TOTAL,
  DEFAULT_SECRETARY_ID,
  isSecretaryId,
  MAX_SECRETARIES,
  SecretaryRegistry,
  secretaryDirOf,
} from './registry';

let root: string;
let seq = 0;

function registry(): SecretaryRegistry {
  return new SecretaryRegistry(root, { now: () => 1000 + seq, randomId: () => `r${++seq}` });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'secretary-registry-'));
  seq = 0;
});

describe('secretary id 与目录', () => {
  it('只认小写字母数字与连字符，拒绝路径片段', () => {
    expect(isSecretaryId('default')).toBe(true);
    expect(isSecretaryId('s-ab12cd34')).toBe(true);
    for (const bad of ['', '..', '../x', 'a/b', 'A', '-x', 'x'.repeat(33), 1, null]) {
      expect(isSecretaryId(bad)).toBe(false);
    }
  });

  it('default 就是根目录，其余在 members 下；非法 id 抛错', () => {
    expect(secretaryDirOf(root, DEFAULT_SECRETARY_ID)).toBe(root);
    expect(secretaryDirOf(root, 's-1')).toBe(join(root, 'members', 's-1'));
    expect(() => secretaryDirOf(root, '../evil')).toThrow();
  });
});

describe('SecretaryRegistry', () => {
  it('没有登记文件时合成 default，且不落盘', () => {
    const list = registry().list();
    expect(list.map((entry) => entry.id)).toEqual([DEFAULT_SECRETARY_ID]);
    expect(existsSync(join(root, 'secretaries.json'))).toBe(false);
    expect(registry().maxRunningTotal()).toBe(DEFAULT_MAX_RUNNING_TOTAL);
  });

  it('新建第二个时才写登记文件，default 一起写进去', () => {
    const created = registry().create();
    expect(created.id).toMatch(/^s-/);
    const saved = JSON.parse(readFileSync(join(root, 'secretaries.json'), 'utf8'));
    expect(saved.secretaries.map((entry: { id: string }) => entry.id)).toEqual([
      DEFAULT_SECRETARY_ID,
      created.id,
    ]);
    expect(existsSync(join(root, 'members', created.id))).toBe(true);
    expect(
      registry()
        .list()
        .map((entry) => entry.id)
    ).toEqual([DEFAULT_SECRETARY_ID, created.id]);
  });

  it('数量有上限', () => {
    const reg = registry();
    for (let index = 1; index < MAX_SECRETARIES; index += 1) reg.create();
    expect(reg.list()).toHaveLength(MAX_SECRETARIES);
    expect(() => reg.create()).toThrow('limit');
  });

  it('删除后不再列出；全部删光就是空列表，不再合成 default', () => {
    const reg = registry();
    const created = reg.create();
    reg.remove(DEFAULT_SECRETARY_ID);
    expect(reg.list().map((entry) => entry.id)).toEqual([created.id]);
    reg.remove(created.id);
    expect(registry().list()).toEqual([]);
  });

  it('登记文件损坏：备份后按目录重建，不丢秘书', () => {
    writeFileSync(join(root, 'profile.json'), '{}');
    mkdirSync(join(root, 'members', 's-keep'), { recursive: true });
    mkdirSync(join(root, 'members', 'BAD..'), { recursive: true });
    writeFileSync(join(root, 'secretaries.json'), '{not json');
    const list = registry().list();
    expect(list.map((entry) => entry.id)).toEqual([DEFAULT_SECRETARY_ID, 's-keep']);
    expect(readdirSync(root).some((name) => name.startsWith('secretaries.json.bad-'))).toBe(true);
  });

  it('损坏且根目录没有 default 的数据：不凭空造出 default', () => {
    mkdirSync(join(root, 'members', 's-only'), { recursive: true });
    writeFileSync(join(root, 'secretaries.json'), '[]');
    expect(
      registry()
        .list()
        .map((entry) => entry.id)
    ).toEqual(['s-only']);
  });

  it('合计上限可读，坏值按默认', () => {
    writeFileSync(
      join(root, 'secretaries.json'),
      JSON.stringify({
        version: 1,
        secretaries: [{ id: 'default', createdAt: 1, order: 0 }],
        maxRunningTotal: 4,
      })
    );
    expect(registry().maxRunningTotal()).toBe(4);
    writeFileSync(
      join(root, 'secretaries.json'),
      JSON.stringify({
        version: 1,
        secretaries: [{ id: 'default', createdAt: 1, order: 0 }],
        maxRunningTotal: -1,
      })
    );
    expect(registry().maxRunningTotal()).toBe(DEFAULT_MAX_RUNNING_TOTAL);
  });
});
