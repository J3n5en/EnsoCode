import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChildRunRecord,
  listChildRuns,
  recordChildRun,
  removeChildRuns,
  resolveChildRunFile,
} from './childRunCatalog';

const PARENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function run(
  parentId: string,
  child: string,
  file: string,
  startedAt: number,
  name = child
): ChildRunRecord {
  return {
    v: 1,
    childId: `${parentId}::cw-${child}`,
    name,
    agentType: 'builtin:scout',
    file,
    startedAt,
  };
}

describe('childRunCatalog', () => {
  let root: string;
  let sessionDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'enso-child-runs-'));
    sessionDir = path.join(root, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function catalogText(): string {
    return readFileSync(path.join(sessionDir, 'child-runs', `${PARENT}.jsonl`), 'utf8');
  }

  it('record 之后 list 能列出，重新 list 仍读到磁盘上的记录', () => {
    expect(recordChildRun(sessionDir, PARENT, run(PARENT, 'a', 'a.jsonl', 10, 'Alpha'))).toBe(true);
    expect(listChildRuns(sessionDir, PARENT)).toEqual([
      expect.objectContaining({
        childId: `${PARENT}::cw-a`,
        name: 'Alpha',
        agentType: 'builtin:scout',
        file: 'a.jsonl',
        startedAt: 10,
      }),
    ]);
    writeFileSync(
      path.join(sessionDir, 'child-runs', `${PARENT}.jsonl`),
      `${catalogText()}{"v":1,"childId":"${PARENT}::cw-b","name":"Beta","file":"b.jsonl","startedAt":20}\n`,
      'utf8'
    );
    expect(listChildRuns(sessionDir, PARENT).map((item) => item.childId)).toEqual([
      `${PARENT}::cw-a`,
      `${PARENT}::cw-b`,
    ]);
  });

  it('同一 childId 且 file 不变不追加；file 变了则覆盖，startedAt 留第一条', () => {
    recordChildRun(sessionDir, PARENT, run(PARENT, 'a', 'a.jsonl', 10, 'Alpha'));
    recordChildRun(sessionDir, PARENT, run(PARENT, 'a', 'a.jsonl', 99, 'Renamed'));
    expect(catalogText().trim().split('\n')).toHaveLength(1);
    expect(listChildRuns(sessionDir, PARENT)).toEqual([
      expect.objectContaining({ name: 'Alpha', file: 'a.jsonl', startedAt: 10 }),
    ]);

    recordChildRun(sessionDir, PARENT, {
      ...run(PARENT, 'a', 'b.jsonl', 99, 'Renamed'),
      agentType: 'builtin:worker',
    });
    expect(catalogText().trim().split('\n')).toHaveLength(2);
    expect(listChildRuns(sessionDir, PARENT)).toEqual([
      expect.objectContaining({
        name: 'Renamed',
        agentType: 'builtin:worker',
        file: 'b.jsonl',
        startedAt: 10,
      }),
    ]);
  });

  it('半行和坏行跳过，其余仍可读', () => {
    const catalog = path.join(sessionDir, 'child-runs', `${PARENT}.jsonl`);
    mkdirSync(path.dirname(catalog), { recursive: true });
    writeFileSync(
      catalog,
      [
        JSON.stringify(run(PARENT, 'a', 'a.jsonl', 1, 'Alpha')),
        '{"v":1,"childId":"',
        '{"nope":true}',
        JSON.stringify(run(PARENT, 'b', 'enso-b.jsonl', 2, 'Beta')),
        '',
      ].join('\n'),
      'utf8'
    );
    expect(listChildRuns(sessionDir, PARENT).map((item) => item.name)).toEqual(['Alpha', 'Beta']);
  });

  it('title 是任务标题：写入后读回，脏值忽略，换文件时没有新标题就留住旧的', () => {
    expect(
      recordChildRun(sessionDir, PARENT, {
        ...run(PARENT, 'a', 'a.jsonl', 10, 'exp-invite-0cd21319'),
        title: '  探测邀请接口  ',
      })
    ).toBe(true);
    expect(listChildRuns(sessionDir, PARENT)[0]).toMatchObject({
      name: 'exp-invite-0cd21319',
      title: '探测邀请接口',
    });

    const catalog = path.join(sessionDir, 'child-runs', `${PARENT}.jsonl`);
    writeFileSync(
      catalog,
      `${JSON.stringify({ ...run(PARENT, 'b', 'b.jsonl', 2, 'Beta'), title: 1 })}\n`,
      'utf8'
    );
    expect(listChildRuns(sessionDir, PARENT)[0]).not.toHaveProperty('title');

    recordChildRun(sessionDir, PARENT, {
      ...run(PARENT, 'a', 'a.jsonl', 10, 'exp-invite-0cd21319'),
      title: '探测邀请接口',
    });
    recordChildRun(sessionDir, PARENT, run(PARENT, 'a', 'b.jsonl', 99, 'exp-invite-0cd21319'));
    expect(
      listChildRuns(sessionDir, PARENT).find((item) => item.childId.endsWith('::cw-a'))
    ).toMatchObject({
      file: 'b.jsonl',
      title: '探测邀请接口',
      startedAt: 10,
    });
  });

  it('childId 不属于该 parent、或 parentId 非法时拒绝写入', () => {
    expect(recordChildRun(sessionDir, PARENT, run(OTHER, 'a', 'a.jsonl', 1))).toBe(false);
    expect(recordChildRun(sessionDir, `../${PARENT}`, run(PARENT, 'a', 'a.jsonl', 1))).toBe(false);
    expect(recordChildRun(sessionDir, 'origin', run('origin', 'a', 'a.jsonl', 1))).toBe(false);
    expect(listChildRuns(sessionDir, PARENT)).toEqual([]);
    expect(listChildRuns(sessionDir, `../${PARENT}`)).toEqual([]);
    expect(existsSync(path.join(sessionDir, 'child-runs'))).toBe(false);
    expect(existsSync(path.join(root, `${PARENT}.jsonl`))).toBe(false);
  });

  it('basename 含斜杠或 .. 时 resolve 返回 null，enso- 前缀判为 safe-journal', () => {
    recordChildRun(sessionDir, PARENT, run(PARENT, 'pi', '2026-08-29T00-00-00-000Z_abc.jsonl', 1));
    recordChildRun(sessionDir, PARENT, run(PARENT, 'safe', 'enso-child.jsonl', 2));
    expect(resolveChildRunFile(sessionDir, PARENT, `${PARENT}::cw-pi`)).toEqual({
      path: path.join(sessionDir, '2026-08-29T00-00-00-000Z_abc.jsonl'),
      format: 'pi',
    });
    expect(resolveChildRunFile(sessionDir, PARENT, `${PARENT}::cw-safe`)).toEqual({
      path: path.join(sessionDir, 'enso-child.jsonl'),
      format: 'safe-journal',
    });
    expect(resolveChildRunFile(sessionDir, PARENT, `${PARENT}::cw-missing`)).toBeNull();
    expect(recordChildRun(sessionDir, PARENT, run(PARENT, 'bad', 'nested/a.jsonl', 3))).toBe(false);
    expect(recordChildRun(sessionDir, PARENT, run(PARENT, 'bad', '..', 3))).toBe(false);
    expect(recordChildRun(sessionDir, PARENT, run(PARENT, 'bad', 'foo..bar.jsonl', 3))).toBe(false);
    const catalog = path.join(sessionDir, 'child-runs', `${PARENT}.jsonl`);
    writeFileSync(
      catalog,
      `${catalogText()}{"v":1,"childId":"${PARENT}::cw-slip","name":"Slip","file":"../escape.jsonl","startedAt":4}\n`,
      'utf8'
    );
    expect(resolveChildRunFile(sessionDir, PARENT, `${PARENT}::cw-slip`)).toBeNull();
  });

  it('removeChildRuns 删除登记的子文件和 catalog，不删其他父的文件，不越出 sessionDir', () => {
    const own = path.join(sessionDir, '2026-08-29T00-00-00-000Z_own.jsonl');
    const kept = path.join(sessionDir, '2026-08-29T00-00-00-000Z_kept.jsonl');
    const otherFile = path.join(sessionDir, '2026-08-29T00-00-00-000Z_other.jsonl');
    const outside = path.join(root, 'escape.jsonl');
    for (const file of [own, kept, otherFile, outside]) writeFileSync(file, '{}\n');
    recordChildRun(sessionDir, PARENT, run(PARENT, 'own', path.basename(own), 1, 'Own'));
    recordChildRun(sessionDir, OTHER, run(OTHER, 'other', path.basename(otherFile), 1, 'Other'));
    const link = path.join(sessionDir, 'link-out.jsonl');
    symlinkSync(outside, link);
    writeFileSync(
      path.join(sessionDir, 'child-runs', `${PARENT}.jsonl`),
      `${catalogText()}{"v":1,"childId":"${PARENT}::cw-slip","name":"Slip","file":"../escape.jsonl","startedAt":2}\n{"v":1,"childId":"${PARENT}::cw-link","name":"Link","file":"link-out.jsonl","startedAt":3}\n`,
      'utf8'
    );

    removeChildRuns(sessionDir, PARENT);
    expect(existsSync(own)).toBe(false);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(otherFile)).toBe(true);
    expect(existsSync(path.join(sessionDir, 'child-runs', `${PARENT}.jsonl`))).toBe(false);
    expect(existsSync(path.join(sessionDir, 'child-runs', `${OTHER}.jsonl`))).toBe(true);
    expect(() => removeChildRuns(sessionDir, PARENT)).not.toThrow();
    expect(() => removeChildRuns(sessionDir, `../${PARENT}`)).not.toThrow();
    expect(existsSync(path.join(sessionDir, 'child-runs', `${OTHER}.jsonl`))).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });
});
