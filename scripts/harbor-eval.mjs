#!/usr/bin/env node
// 用当前检出打包 enso-server，再用 Harbor 跑评测。
// 模型、key、端点从 .env.harbor（或 .env）读，不写在脚本里。
// 用法: node scripts/harbor-eval.mjs [--dataset terminal-bench@2.0] [--limit 1]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseEnvText(text) {
  const env = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[line.slice(0, eq).trim()] = value;
  }
  return env;
}

export function rewriteLoopback(url) {
  const parsed = new URL(url);
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
    parsed.hostname = 'host.docker.internal';
  }
  return parsed.toString().replace(/\/$/, '');
}

export function normalizeApiFormat(format) {
  const text = (format || 'openai-responses').toLowerCase().replaceAll('_', '-');
  if (text === 'openai-completions') return 'openai_chat_completions';
  if (text === 'openai-responses') return 'openai_responses';
  if (text === 'anthropic-messages') return 'anthropic_messages';
  throw new Error(`不认识的 HARBOR_API_FORMAT: ${format}`);
}

export function harborModelArg(model, apiFormat) {
  const prefix = apiFormat.startsWith('anthropic')
    ? 'anthropic'
    : apiFormat.startsWith('google')
      ? 'google'
      : 'openai';
  return model.startsWith(`${prefix}/`) ? model : `${prefix}/${model}`;
}

export function resolveHarborConfig(env) {
  const keyName = 'HARBOR_API_KEY';
  const missing = [];
  if (!env.HARBOR_API_KEY) missing.push(keyName);
  if (!env.HARBOR_MODEL) missing.push('HARBOR_MODEL');
  if (!env.HARBOR_BASE_URL) missing.push('HARBOR_BASE_URL');
  if (missing.length > 0) {
    throw new Error(`缺少 ${missing.join(', ')}。复制 .env.harbor.example 为 .env.harbor 再填`);
  }
  return {
    keyName,
    apiKey: env.HARBOR_API_KEY,
    model: env.HARBOR_MODEL,
    baseUrl: rewriteLoopback(env.HARBOR_BASE_URL),
    apiFormat: normalizeApiFormat(env.HARBOR_API_FORMAT),
  };
}

export function buildHarborArgs({ dataset, limit, concurrency, jobsDir, jobName, config }) {
  return [
    'run',
    '-d',
    dataset,
    '-l',
    String(limit),
    '-n',
    String(concurrency),
    '-y',
    '-o',
    jobsDir,
    '--job-name',
    jobName,
    '-a',
    'eval.harbor.enso_agent:EnsoCodeAgent',
    '-m',
    harborModelArg(config.model, config.apiFormat),
    '--api-format',
    config.apiFormat,
    '--base-url',
    config.baseUrl,
    '--api-key-name',
    config.keyName,
  ];
}

export function loadEnvFiles(dir, processEnv, read = readFileSync) {
  const fromFiles = {};
  for (const name of ['.env', '.env.harbor']) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    Object.assign(fromFiles, parseEnvText(read(file, 'utf8')));
  }
  return { ...fromFiles, ...processEnv };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} 缺参数`);
      return value;
    };
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--skip-pack') out.skipPack = true;
    else if (arg === '--dataset' || arg === '-d') out.dataset = take();
    else if (arg === '--limit' || arg === '-l') out.limit = take();
    else if (arg === '--concurrency' || arg === '-n') out.concurrency = take();
    else if (arg === '--job-name') out.jobName = take();
    else if (arg === '--jobs-dir' || arg === '-o') out.jobsDir = take();
    else if (arg === '--adapter-root') out.adapterRoot = take();
    else throw new Error(`不认识的参数 ${arg}`);
  }
  return out;
}

function help() {
  console.log(`用法: node scripts/harbor-eval.mjs [选项]

打包当前检出并跑 Harbor。连接信息放在仓库根的 .env.harbor（已 gitignore），不要写进命令。
至少填 HARBOR_API_KEY、HARBOR_MODEL、HARBOR_BASE_URL。127.0.0.1 和 localhost 会改成 host.docker.internal。

  --dataset, -d     数据集，默认 terminal-bench@2.0，也可用 HARBOR_DATASET
  --limit, -l       题数，默认 1，也可用 HARBOR_LIMIT
  --concurrency, -n 并发，默认 1
  --jobs-dir, -o    日志目录，默认系统临时目录下的 enso-harbor-jobs
  --job-name        本次作业名，默认时间戳
  --skip-pack       不重新打包，沿用 ENSO_SERVER_TARBALL
  --adapter-root    含 eval/harbor 的检出，默认本仓库
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return;
  }
  const env = loadEnvFiles(root, process.env);
  const config = resolveHarborConfig(env);
  const adapterRoot = path.resolve(args.adapterRoot || env.HARBOR_ADAPTER_ROOT || root);
  const agent = path.join(adapterRoot, 'eval/harbor/enso_agent.py');
  if (!existsSync(agent)) {
    throw new Error(
      `找不到 ${agent}。当前检出没有 Harbor 适配器时，用 --adapter-root 指到有 eval/harbor 的检出`
    );
  }
  const dataset = args.dataset || env.HARBOR_DATASET || 'terminal-bench@2.0';
  const limit = args.limit || env.HARBOR_LIMIT || '1';
  const concurrency = args.concurrency || '1';
  const jobsDir = path.resolve(
    args.jobsDir || env.HARBOR_JOBS_DIR || path.join(os.tmpdir(), 'enso-harbor-jobs')
  );
  const jobName = args.jobName || new Date().toISOString().replace(/[:.]/g, '-');
  let tarball = env.ENSO_SERVER_TARBALL;
  if (!args.skipPack) {
    const dest = path.join(os.tmpdir(), 'enso-harbor-pack');
    const packed = spawnSync(process.execPath, ['scripts/pack-server.mjs', '--out', dest], {
      cwd: root,
      stdio: 'inherit',
    });
    if (packed.status !== 0) process.exit(packed.status ?? 1);
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    tarball = path.join(dest, `ensocode-server-${version}.tgz`);
  }
  if (!tarball || !existsSync(tarball))
    throw new Error(`找不到安装包 ${tarball || '(未设置 ENSO_SERVER_TARBALL)'}`);
  const harborArgs = buildHarborArgs({ dataset, limit, concurrency, jobsDir, jobName, config });
  console.log(`数据集 ${dataset}，题数 ${limit}，日志 ${path.join(jobsDir, jobName)}`);
  console.log(`模型 ${config.model}，端点 ${config.baseUrl}`);
  const child = spawnSync('harbor', harborArgs, {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...env,
      [config.keyName]: config.apiKey,
      ENSO_SERVER_TARBALL: tarball,
      PYTHONPATH: adapterRoot,
    },
  });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
