import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  KG_EXTRACT_MAX_TOKENS,
  KG_MAX_ATTEMPTS,
  KG_MAX_ENTITIES,
  KG_MAX_RELATIONS,
} from '@shared/memory/constants';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentHash } from './contentHash';
import { cleanupOrphanMentions, openMemoryDb } from './db';
import {
  applyExtraction,
  countFailedKgJobs,
  ensureKgJob,
  ensurePendingKgJobs,
  extractLevel1,
  findMemoriesByEntity,
  type KgExtraction,
  kgFingerprint,
  listEntityNames,
  listKgJobs,
  listResumableKgJobs,
  normalizeExtraction,
  parseKgResponse,
  retryFailedKgJobs,
  runKgJob,
} from './kg';
import { createMemory, updateMemory } from './store';
import type { Memory } from './types';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-memory-kg-'));
  db = openMemoryDb(path.join(dir, 'memory.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const create = async (content: string, spaceId = 'global', onCreated?: (m: Memory) => void) => {
  const r = await createMemory(db, { content, spaceId }, { onCreated });
  if (r.status !== 'inserted') throw new Error('unexpected');
  return r.memory;
};
const json = (x: unknown) => JSON.stringify(x);
const entity = (name: string, type = 'TOOL', confidence = 0.9) => ({
  name,
  type,
  description: `${name} desc`,
  confidence,
});
// 模型 JSON 用 confidence；normalizeExtraction 的入参用 strength，两个键都给
const rel = (source: string, target: string, relation = 'USES', confidence = 0.8) => ({
  source,
  target,
  relation,
  confidence,
  strength: confidence,
});
const sample = json({
  entities: [entity('Kubernetes'), entity('Docker'), entity('Sarah', 'PERSON')],
  relationships: [rel('Sarah', 'Kubernetes'), rel('Kubernetes', 'Docker', 'WORKS_WITH')],
});
const count = (table: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('parseKgResponse / normalizeExtraction', () => {
  it('解析 entities + relationships 形状', () => {
    const x = parseKgResponse(sample);
    expect(x?.entities.map((e) => e.name)).toEqual(['Kubernetes', 'Docker', 'Sarah']);
    expect(x?.relations).toHaveLength(2);
    expect(x?.relations[0]).toMatchObject({
      source: 'Sarah',
      target: 'Kubernetes',
      relation: 'USES',
    });
  });

  it('脏 JSON：围栏、前后废话、尾逗号、截断都能容错；完全不可解析返回 null', () => {
    const dirty = `Sure! \`\`\`json\n{"entities":[{"name":"Redis","type":"tool",},],"relationships":[]}\n\`\`\` done`;
    expect(parseKgResponse(dirty)?.entities[0]?.name).toBe('Redis');
    const truncated = `{"entities":[{"name":"Redis","type":"TOOL","confidence":0.9},{"name":"Postg`;
    expect(parseKgResponse(truncated)?.entities.map((e) => e.name)).toEqual(['Redis']);
    expect(parseKgResponse('I cannot do that')).toBeNull();
    expect(parseKgResponse('[]')).toBeNull();
  });

  it('小模型脏形状：think 残片、字符串实体、中文键、entity_name；蒸馏形状不当成功', () => {
    const think = `<think>draft {"entities":[]}\n</think>\n{"entities":[{"name":"Redis","type":"TOOL"}],"relationships":[]}`;
    expect(parseKgResponse(think)?.entities.map((e) => e.name)).toEqual(['Redis']);
    expect(
      parseKgResponse('{"entities":["Redis","Memcached"],"relationships":[]}')?.entities.map(
        (e) => e.name
      )
    ).toEqual(['Redis', 'Memcached']);
    expect(parseKgResponse('{"实体":[{"名称":"Redis","类型":"TOOL"}]}')?.entities[0]?.name).toBe(
      'Redis'
    );
    expect(
      parseKgResponse('{"entities":[{"entity_name":"Redis","entity_type":"TOOL"}]}')?.entities[0]
        ?.name
    ).toBe('Redis');
    expect(parseKgResponse('[{"name":"Redis"}]')?.entities[0]?.name).toBe('Redis');
    expect(
      parseKgResponse('{"memories":[{"title":"t","content":"c","importance":0.8}]}')
    ).toBeNull();
  });

  it('归一：type/relation 转 UPPER_SNAKE，非法回退缺省；缺 confidence 给缺省', () => {
    const x = parseKgResponse(
      json({
        entities: [
          { name: 'Redis', type: 'in-memory store' },
          { name: 'Bob', type: '人' },
        ],
        relationships: [{ source: 'Bob', target: 'Redis', relation: 'works with' }],
      })
    );
    expect(x?.entities[0]).toMatchObject({ type: 'IN_MEMORY_STORE', confidence: 0.5 });
    expect(x?.entities[1]?.type).toBe('CONCEPT');
    expect(x?.relations[0]?.relation).toBe('WORKS_WITH');
  });

  it('同名不同写法在一次抽取内合并，其他写法进 aliases；关系按归一键解析', () => {
    const x = normalizeExtraction({
      entities: [entity('PostgreSQL'), entity('postgre sql'), entity('Postgre-SQL')],
      relations: [rel('postgre sql', 'PostgreSQL'), rel('Postgre-SQL', 'Nope')],
    });
    expect(x.entities).toHaveLength(1);
    expect(x.entities[0]?.name).toBe('PostgreSQL');
    expect(x.entities[0]?.aliases.sort()).toEqual(['Postgre-SQL', 'postgre sql']);
    // 自环与指向未抽取实体的关系都丢
    expect(x.relations).toHaveLength(0);
  });

  it('超量截断：>10 实体 / >20 关系被硬截；超长实体名与描述被裁', () => {
    const names = Array.from({ length: 30 }, (_, i) => `E${i}`);
    const x = normalizeExtraction({
      entities: names.map((n) => ({ ...entity(n), description: 'd'.repeat(5000) })),
      relations: names.slice(1).map((n) => rel('E0', n)),
    });
    expect(x.entities).toHaveLength(KG_MAX_ENTITIES);
    expect(x.relations.length).toBeLessThanOrEqual(KG_MAX_RELATIONS);
    expect(x.relations.length).toBe(KG_MAX_ENTITIES - 1);
    expect(x.entities[0]?.description?.length).toBeLessThanOrEqual(300);
    const long = normalizeExtraction({ entities: [entity('x'.repeat(1000))], relations: [] });
    expect(long.entities[0]?.name.length).toBeLessThanOrEqual(100);
    expect(normalizeExtraction({ entities: [entity('   ')], relations: [] }).entities).toHaveLength(
      0
    );
  });
});

describe('applyExtraction 实体去重 / space 隔离', () => {
  const ext = (names: string[], relations: KgExtraction['relations'] = []) =>
    normalizeExtraction({ entities: names.map((n) => entity(n)), relations });

  it('两条记忆提到同一实体（不同大小写 / 空白）只建一个实体，两条 mentions', async () => {
    const a = await create('We deploy on Kubernetes.');
    const b = await create('The kube cluster runs on kubernetes with spaces.');
    applyExtraction(db, a, ext(['Kubernetes']));
    applyExtraction(db, b, ext(['kubernetes ']));
    expect(count('entities')).toBe(1);
    expect(count('mentions')).toBe(2);
    expect(db.prepare('SELECT alias FROM entity_aliases').all()).toEqual([{ alias: 'kubernetes' }]);
    expect(listEntityNames(db, b.id)).toEqual(['Kubernetes']);
  });

  it('不同 space 同名实体互不合并；findMemoriesByEntity 按 space 过滤并支持别名', async () => {
    const g = await create('Kubernetes globally', 'global');
    const p = await create('集群编排方案讨论', 'proj:p1');
    applyExtraction(db, g, ext(['Kubernetes']));
    applyExtraction(
      db,
      p,
      normalizeExtraction({ entities: [entity('kubernetes'), entity('集群编排')], relations: [] })
    );
    expect(count('entities')).toBe(3);
    expect(findMemoriesByEntity(db, 'KUBERNETES', ['global']).map((m) => m.id)).toEqual([g.id]);
    expect(
      findMemoriesByEntity(db, 'kubernetes', ['global', 'proj:p1'])
        .map((m) => m.id)
        .sort()
    ).toEqual([g.id, p.id].sort());
    expect(findMemoriesByEntity(db, '集群编排', ['proj:p1']).map((m) => m.id)).toEqual([p.id]);
    expect(findMemoriesByEntity(db, 'nothing', ['global'])).toEqual([]);
  });

  it('同实体不同措辞（正文只含「集群编排」但 MENTIONS 同一实体）被召回', async () => {
    const a = await create('Kubernetes is our orchestrator.');
    const b = await create('集群编排层用它来做滚动发布。');
    applyExtraction(db, a, ext(['Kubernetes']));
    applyExtraction(db, b, ext(['Kubernetes']));
    expect(
      findMemoriesByEntity(db, 'kubernetes', ['global'])
        .map((m) => m.id)
        .sort()
    ).toEqual([a.id, b.id].sort());
  });

  it('关系写入并按 (source,target,type) 去重取最大 strength；重抽同一记忆先清旧 mentions', async () => {
    const a = await create('Sarah uses Kubernetes with Docker.');
    applyExtraction(
      db,
      a,
      ext(['Sarah', 'Kubernetes', 'Docker'], [rel('Sarah', 'Kubernetes', 'USES', 0.6)])
    );
    applyExtraction(db, a, ext(['Sarah', 'Kubernetes'], [rel('Sarah', 'Kubernetes', 'USES', 0.9)]));
    expect(count('entity_relations')).toBe(1);
    expect(
      (db.prepare('SELECT strength FROM entity_relations').get() as { strength: number }).strength
    ).toBe(0.9);
    expect(listEntityNames(db, a.id).sort()).toEqual(['Kubernetes', 'Sarah']);
  });

  it('记忆正文变更 / 删除时 mentions 跟着清；开库清孤儿实体', async () => {
    const a = await create('Kubernetes is used here.');
    const b = await create('Docker is used there.');
    applyExtraction(db, a, ext(['Kubernetes']));
    applyExtraction(db, b, ext(['Docker']));
    updateMemory(db, a.id, { content: 'Now we use Nomad instead.' });
    expect(listEntityNames(db, a.id)).toEqual([]);
    updateMemory(db, b.id, { lifecycleState: 'deleted' });
    expect(count('mentions')).toBe(0);
    cleanupOrphanMentions(db);
    expect(count('entities')).toBe(0);
  });

  it('开库清理：指向不存在记忆的 mentions 与随之失去引用的实体 / 别名 / 关系', async () => {
    const a = await create('Kubernetes with Docker.');
    applyExtraction(
      db,
      a,
      ext(['Kubernetes', 'kubernetes', 'Docker'], [rel('Kubernetes', 'Docker')])
    );
    db.prepare("UPDATE memories SET lifecycle_state = 'deleted' WHERE id = ?").run(a.id);
    cleanupOrphanMentions(db);
    for (const t of ['mentions', 'entities', 'entity_aliases', 'entity_relations'])
      expect(count(t)).toBe(0);
  });
});

describe('kg 任务：幂等、续跑、失败不影响记忆', () => {
  const calls: string[] = [];
  const completeWith =
    (raw: string) =>
    async (_s: string, user: string): Promise<string> => {
      calls.push(user);
      return raw;
    };
  beforeEach(() => {
    calls.length = 0;
  });

  it('createMemory 的 onCreated 只对真正新插入的行触发；hash 去重 / 幂等命中不触发', async () => {
    const seen: string[] = [];
    const m = await create('Kubernetes is our orchestrator.', 'global', (x) => seen.push(x.id));
    await create('Kubernetes is our orchestrator.', 'global', (x) => seen.push(x.id));
    await createMemory(
      db,
      { content: 'k2', spaceId: 'global', idempotencyKey: 'ik' },
      { onCreated: (x) => seen.push(x.id) }
    );
    await createMemory(
      db,
      { content: 'k2', spaceId: 'global', idempotencyKey: 'ik' },
      { onCreated: (x) => seen.push(x.id) }
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(m.id);
    // hook 抛错不影响创建
    const r = await createMemory(
      db,
      { content: 'k3', spaceId: 'global' },
      {
        onCreated: () => {
          throw new Error('boom');
        },
      }
    );
    expect(r.status).toBe('inserted');
  });

  it('ensureKgJob 幂等：同记忆同内容一个任务；内容变了旧任务 cancelled 新任务建；done 后不重建', async () => {
    const m = await create('Sarah uses Kubernetes with Docker.');
    const j1 = ensureKgJob(db, m.id);
    expect(j1?.fingerprint).toBe(kgFingerprint(m.id, m.content));
    expect(ensureKgJob(db, m.id)?.id).toBe(j1?.id);
    updateMemory(db, m.id, { content: 'Sarah now uses Nomad.' });
    const j2 = ensureKgJob(db, m.id);
    expect(j2?.id).not.toBe(j1?.id);
    expect(listKgJobs(db).find((j) => j.id === j1?.id)?.status).toBe('cancelled');
    await runKgJob(db, j2 as NonNullable<typeof j2>, {
      complete: completeWith(json({ entities: [entity('Nomad')], relationships: [] })),
    });
    expect(ensureKgJob(db, m.id)).toBeNull();
    expect(calls).toHaveLength(1);
    // 已删除记忆不建任务
    updateMemory(db, m.id, { lifecycleState: 'deleted' });
    expect(ensureKgJob(db, m.id)).toBeNull();
    expect(ensureKgJob(db, 'nope')).toBeNull();
  });

  it('旧指纹抽空成功不挡住补抽；ensurePendingKgJobs 给最新记忆建任务', async () => {
    const m = await create('Sarah uses Kubernetes with Docker.');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memory_jobs (kind, target, status, cursor, total, done, failed, created_at, updated_at)
       VALUES ('kg', ?, 'done', 1, 0, 0, 0, ?, ?)`
    ).run(`${m.id}#${contentHash(m.content)}`, now, now);
    const job = ensureKgJob(db, m.id);
    expect(job?.fingerprint).toBe(kgFingerprint(m.id, m.content));
    expect(job?.fingerprint).not.toBe(`${m.id}#${contentHash(m.content)}`);
    expect(job?.status).toBe('pending');
    await runKgJob(db, job as NonNullable<typeof job>, {
      complete: completeWith(json({ entities: [entity('Kubernetes')], relationships: [] })),
    });
    expect(ensurePendingKgJobs(db)).toBe(0);
    const extra = await create('Helm charts package the deployment.');
    expect(ensurePendingKgJobs(db)).toBe(1);
    expect(ensureKgJob(db, extra.id)?.memoryId).toBe(extra.id);
  });

  it('runKgJob：提示词含记忆正文、密钥已打码；实体名里不出现密钥；写入实体与关系', async () => {
    const m = await create(
      'Sarah uses Kubernetes with Docker. token: sk-abcdefghijklmnopqrstuvwxyz1234'
    );
    const job = ensureKgJob(db, m.id) as NonNullable<ReturnType<typeof ensureKgJob>>;
    const done = await runKgJob(db, job, {
      complete: completeWith(
        json({
          entities: [entity('Kubernetes'), entity('sk-abcdefghijklmnopqrstuvwxyz1234', 'TOKEN')],
          relationships: [rel('Kubernetes', 'sk-abcdefghijklmnopqrstuvwxyz1234')],
        })
      ),
    });
    expect(done.status).toBe('done');
    expect(calls[0]).toContain('Sarah uses Kubernetes');
    expect(calls[0]).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234');
    expect(calls[0]).toContain('[REDACTED]');
    const names = (db.prepare('SELECT name FROM entities').all() as { name: string }[]).map(
      (r) => r.name
    );
    expect(names).toEqual(['Kubernetes']);
    expect(count('entity_relations')).toBe(0);
    expect(done.total).toBe(1);
  });

  it('LLM 抛错 / 输出不可解析：任务留 pending 记 error，attempts 累计，超限标 done；记忆本身不受影响', async () => {
    const m = await create('Kubernetes is our orchestrator.');
    const job = ensureKgJob(db, m.id) as NonNullable<ReturnType<typeof ensureKgJob>>;
    let j = await runKgJob(db, job, {
      complete: async () => {
        throw new Error('provider down');
      },
    });
    expect(j.status).toBe('pending');
    expect(j.attempts).toBe(1);
    expect(j.error).toContain('provider down');
    for (let i = 1; i < KG_MAX_ATTEMPTS; i++)
      j = await runKgJob(db, j, { complete: completeWith('garbage') });
    expect(j.status).toBe('done');
    expect(j.error).toContain('not parseable');
    expect(count('entities')).toBe(0);
    expect(db.prepare('SELECT lifecycle_state FROM memories WHERE id = ?').get(m.id)).toEqual({
      lifecycle_state: 'active',
    });
  });

  it('重启续跑：pending 与半路 running 都可列出；内容已变的任务跑时标 cancelled；模型无产出直接 done', async () => {
    const a = await create('Kubernetes A');
    const b = await create('Docker B');
    const ja = ensureKgJob(db, a.id) as NonNullable<ReturnType<typeof ensureKgJob>>;
    ensureKgJob(db, b.id);
    db.prepare("UPDATE memory_jobs SET status = 'running' WHERE id = ?").run(ja.id);
    expect(listResumableKgJobs(db).map((j) => j.memoryId)).toEqual([a.id, b.id]);
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('changed', a.id);
    expect((await runKgJob(db, ja, { complete: completeWith(sample) })).status).toBe('cancelled');
    const jb = listResumableKgJobs(db)[0] as NonNullable<ReturnType<typeof ensureKgJob>>;
    const done = await runKgJob(db, jb, {
      complete: completeWith(json({ entities: [], relationships: [] })),
    });
    expect(done.status).toBe('done');
    expect(listResumableKgJobs(db)).toEqual([]);
  });

  it('同一任务连续失败 3 次（每次从 listResumableKgJobs 重读，模拟重启）后进入失败终态且不再 resumable', async () => {
    const m = await create('Kubernetes is our orchestrator.');
    const created = ensureKgJob(db, m.id);
    expect(created).not.toBeNull();
    let id = created?.id ?? 0;
    const fail = async () => {
      throw new Error('provider down');
    };
    for (let i = 0; i < KG_MAX_ATTEMPTS; i++) {
      const current = listResumableKgJobs(db).find((j) => j.id === id);
      expect(current?.attempts).toBe(i);
      const next = await runKgJob(db, current as NonNullable<typeof current>, { complete: fail });
      expect(next.attempts).toBe(i + 1);
      id = next.id;
      if (i + 1 < KG_MAX_ATTEMPTS) expect(next.status).toBe('pending');
    }
    const finished = listKgJobs(db).find((j) => j.id === id);
    expect(finished).toMatchObject({ status: 'done', failed: 1, attempts: KG_MAX_ATTEMPTS });
    expect(finished?.error).toContain('provider down');
    expect(listResumableKgJobs(db).some((j) => j.id === id)).toBe(false);
    expect(countFailedKgJobs(db)).toBe(1);
  });

  it('用尽重试的失败 failed=1 与成功 done 可区分；重试只把失败项放回 pending 并能再跑', async () => {
    const bad = await create('Unparseable source text.');
    const good = await create('Sarah uses Kubernetes with Docker.');
    const legacy = await create('Legacy failed extraction.');
    let failed = ensureKgJob(db, bad.id) as NonNullable<ReturnType<typeof ensureKgJob>>;
    for (let i = 0; i < KG_MAX_ATTEMPTS; i++) {
      const current = listResumableKgJobs(db).find((j) => j.id === failed.id);
      failed = await runKgJob(db, current as NonNullable<typeof current>, {
        complete: completeWith('garbage'),
      });
    }
    const success = await runKgJob(
      db,
      ensureKgJob(db, good.id) as NonNullable<ReturnType<typeof ensureKgJob>>,
      { complete: completeWith(sample) }
    );
    expect(failed).toMatchObject({ status: 'done', failed: 1 });
    expect(failed.error).toContain('not parseable');
    expect(success).toMatchObject({ status: 'done', failed: 0, error: null });

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memory_jobs (kind, target, status, cursor, total, done, failed, error, created_at, updated_at)
       VALUES ('kg', ?, 'done', 3, 0, 0, 0, 'kg extraction failed: model output is not parseable JSON', ?, ?)`
    ).run(kgFingerprint(legacy.id, legacy.content), now, now);
    db.prepare(
      `INSERT INTO memory_jobs (kind, target, status, cursor, total, done, failed, error, created_at, updated_at)
       VALUES ('distill', 'session-1', 'done', 3, 0, 0, 1, 'distill failed', ?, ?)`
    ).run(now, now);
    const pending = ensureKgJob(db, (await create('Still queued.')).id);
    expect(pending?.attempts).toBe(0);

    const reset = retryFailedKgJobs(db);
    expect(reset.map((j) => j.memoryId).sort()).toEqual([bad.id, legacy.id].sort());
    expect(
      reset.every(
        (j) => j.status === 'pending' && j.attempts === 0 && j.failed === 0 && j.error === null
      )
    ).toBe(true);
    expect(
      listResumableKgJobs(db)
        .map((j) => j.memoryId)
        .sort()
    ).toEqual([bad.id, legacy.id, pending?.memoryId].sort());
    expect(listKgJobs(db).find((j) => j.id === success.id)).toMatchObject({
      status: 'done',
      failed: 0,
      error: null,
    });
    expect(
      db.prepare("SELECT status, error FROM memory_jobs WHERE kind = 'distill'").get()
    ).toEqual({
      status: 'done',
      error: 'distill failed',
    });

    const rerun = await runKgJob(
      db,
      listResumableKgJobs(db).find((j) => j.memoryId === bad.id) as NonNullable<
        ReturnType<typeof ensureKgJob>
      >,
      { complete: completeWith(sample) }
    );
    expect(rerun).toMatchObject({ status: 'done', failed: 0, error: null, attempts: 1 });
    expect(listResumableKgJobs(db).some((j) => j.id === rerun.id)).toBe(false);
    expect(countFailedKgJobs(db)).toBe(0);
  });

  it('extractLevel1 用 system schema，正文在 user，并限制 maxTokens', async () => {
    let system: string | null = null;
    let maxTokens: number | undefined;
    const x = await extractLevel1('Sarah uses Docker.', async (s, u, opts) => {
      system = s;
      maxTokens = opts?.maxTokens;
      expect(u).toContain('Sarah uses Docker.');
      expect(u).not.toContain('DIRECTLY OUTPUT THE JSON');
      return sample;
    });
    expect(system).toContain('"entities"');
    expect(maxTokens).toBeGreaterThanOrEqual(1024);
    expect(x.entities).toHaveLength(3);
  });

  it('解析失败时同一 attempt 内再用 Output JSON only 补一次；complete 抛错不补', async () => {
    expect(KG_EXTRACT_MAX_TOKENS).toBeGreaterThanOrEqual(4096);
    const prompts: string[] = [];
    const x = await extractLevel1('Sarah uses Docker.', async (_s, user, opts) => {
      prompts.push(user);
      expect(opts?.maxTokens).toBe(KG_EXTRACT_MAX_TOKENS);
      return prompts.length === 1 ? 'not json' : sample;
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Output JSON only');
    expect(x.entities.length).toBeGreaterThan(0);

    let calls = 0;
    await expect(
      extractLevel1('x', async () => {
        calls += 1;
        return 'nope';
      })
    ).rejects.toThrow(/not parseable/);
    expect(calls).toBe(2);

    calls = 0;
    await expect(
      extractLevel1('x', async () => {
        calls += 1;
        throw new Error('provider down');
      })
    ).rejects.toThrow(/provider down/);
    expect(calls).toBe(1);
  });
});
