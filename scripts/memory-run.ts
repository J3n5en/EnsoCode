/**
 * 独立跑记忆管线（stage 1 抽取 + phase 2 合并），不依赖 GUI。
 *
 *   npx tsx scripts/memory-run.ts [--cwd <project>] [--out <dir>] [--provider <settingsProviderId>]
 *       [--model <modelId>] [--phase2-model <modelId>] [--data-dir <userData>]
 *       [--limit <n>] [--idle-hours <h>] [--max-age-days <d>] [--reuse-artifacts] [--seed-prior]
 *       [--concurrency <n>=4] [--phase2-only] [--dev]
 *
 * 默认写到 <cwd>/.enso/memory-debug/ 而不是真实记忆根，避免污染；
 * --reuse-artifacts 复制真实根的 stage1_outputs.json（只重跑 phase 2 时用），
 * --seed-prior 复制真实根的 MEMORY.md / memory_summary.md 作为增量合并基线。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getMemoryRoot } from '../src/agent/localMemory';
import { type MemoryCompleteSimple, runMemoryPipeline } from '../src/agent/memory/pipeline';
import { createMemoryCompleteSimple } from '../src/agent/memory/runner';
import { initializeWorkerRuntime, resolveBaseModelOrRefresh } from '../src/agent/supervisor';
import { pickModelCapabilityOverrides } from '../src/shared/modelCatalog';
import type { SpawnModelConfig } from '../src/shared/types/agent';
import type { ModelProvider } from '../src/shared/types/llm';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const cwd = path.resolve(arg('cwd') ?? process.cwd());
const dataDir =
  arg('data-dir') ??
  path.join(
    os.homedir(),
    'Library/Application Support',
    flag('dev') ? 'enso-code-dev' : 'enso-code'
  );
const agentDir = path.join(dataDir, 'agent', 'pi-agent');
const sessionDir = path.join(dataDir, 'agent', 'sessions');
const realRoot = getMemoryRoot(agentDir, cwd);
const outRoot = path.resolve(arg('out') ?? path.join(cwd, '.enso', 'memory-debug'));

const settings = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
const state = settings['enso-settings'].state as {
  providers: ModelProvider[];
  defaultModel?: { providerId: string; modelId: string };
};
const providerId = arg('provider') ?? state.defaultModel?.providerId;
const modelId = arg('model') ?? state.defaultModel?.modelId;
const provider = state.providers.find((p) => p.id === providerId);
if (!provider || !modelId) throw new Error(`provider/model not found: ${providerId}/${modelId}`);

function spawnConfig(p: ModelProvider, id: string): SpawnModelConfig {
  const entry = p.models.find((m) => m.id === id);
  return {
    api: p.api,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    modelId: id,
    settingsProviderId: p.id,
    ...(p.oauthAccountKey ? { oauthAccountKey: p.oauthAccountKey } : {}),
    ...(!p.oauthAccountKey ? pickModelCapabilityOverrides(entry) : {}),
  };
}

/** 每次模型调用的 prompt / 回复落到 <out>/trace/，方便看为什么解析失败 */
function traced(inner: MemoryCompleteSimple): MemoryCompleteSimple {
  const traceDir = path.join(outRoot, 'trace');
  mkdirSync(traceDir, { recursive: true });
  let n = 0;
  return async (input) => {
    const id = `${String(++n).padStart(3, '0')}-phase${input.phase}`;
    writeFileSync(
      path.join(traceDir, `${id}.prompt.md`),
      `# system\n${input.systemPrompt}\n\n# user\n${input.userText}\n`
    );
    const t = Date.now();
    try {
      const text = await inner(input);
      writeFileSync(path.join(traceDir, `${id}.response.txt`), text);
      console.log(`  ${id}: ${text.length} chars in ${((Date.now() - t) / 1000).toFixed(1)}s`);
      return text;
    } catch (err) {
      writeFileSync(path.join(traceDir, `${id}.error.txt`), String(err));
      console.log(`  ${id}: ERROR ${String(err).slice(0, 200)}`);
      throw err;
    }
  };
}

async function main() {
  mkdirSync(outRoot, { recursive: true });
  if (flag('reuse-artifacts') && existsSync(path.join(realRoot, 'stage1_outputs.json'))) {
    copyFileSync(
      path.join(realRoot, 'stage1_outputs.json'),
      path.join(outRoot, 'stage1_outputs.json')
    );
  }
  if (flag('seed-prior')) {
    for (const f of ['MEMORY.md', 'memory_summary.md']) {
      if (existsSync(path.join(realRoot, f)))
        copyFileSync(path.join(realRoot, f), path.join(outRoot, f));
    }
  }
  if (flag('phase2-only')) {
    // 标记 dirty，且把 idle 阈值拉到极大让 stage 1 无候选
    const jobsFile = path.join(outRoot, '.jobs.json');
    const jobs = existsSync(jobsFile) ? JSON.parse(readFileSync(jobsFile, 'utf8')) : {};
    jobs.stage1 ??= {};
    jobs.global = { ...(jobs.global ?? { watermark: 0, status: 'done' }), dirty: true };
    writeFileSync(jobsFile, `${JSON.stringify(jobs, null, 2)}\n`);
  }

  const runtime = await initializeWorkerRuntime(
    await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    })
  );
  const sessionModel = await resolveBaseModelOrRefresh(runtime, spawnConfig(provider, modelId));
  const phase2Id = arg('phase2-model');
  const phase2Model = phase2Id
    ? await resolveBaseModelOrRefresh(runtime, spawnConfig(provider, phase2Id))
    : undefined;

  console.log(
    `cwd=${cwd}\nsessions=${sessionDir}\nout=${outRoot}\nmodel=${provider.id}/${modelId}`
  );
  const started = Date.now();
  const result = await runMemoryPipeline({
    memoryRoot: outRoot,
    sessionDir,
    cwd,
    nowSec: Math.floor(Date.now() / 1000),
    workerToken: `cli-${process.pid}`,
    completeSimple: traced(createMemoryCompleteSimple({ runtime, sessionModel, phase2Model })),
    onProgress: (p) => console.log(`[${p.phase}] ${p.current}/${p.total}`),
    stageOneConcurrency: Number(arg('concurrency') ?? 4),
    stageOneSelect: {
      maxRolloutsPerStartup: Number(arg('limit') ?? (flag('phase2-only') ? 0 : 64)),
      minRolloutIdleHours: Number(arg('idle-hours') ?? 12),
      maxRolloutAgeDays: Number(arg('max-age-days') ?? 30),
    },
  });
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`, result);
  console.log(`→ ${path.join(outRoot, 'memory_summary.md')}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
