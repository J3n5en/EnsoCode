#!/usr/bin/env node
// 搭建隔离验证环境（不碰真实 userData）。用法：
//   node mk-env.mjs /tmp/enso-x [providerCount]
// 产出：
//   /tmp/enso-x/settings.json    pv-A[/pv-B...] 指向 127.0.0.1:8899 的 fake provider
//   /tmp/enso-x-proj/            空项目目录（含 README.md）
// 配套：
//   node scripts/fake-provider-issue-27.mjs   # 仓库根目录，起 8899 fake provider
//   ENSO_USER_DATA_DIR=/tmp/enso-x pnpm dev
// fake provider 支持 [[tool:name {json}]] 指令触发 tool_use；
// /__requests 可查每个请求实际带的凭证尾号（区分 provider 铁证）。

import { mkdirSync, writeFileSync } from 'node:fs';

const dir = process.argv[2];
if (!dir || !dir.startsWith('/tmp/')) {
  console.error('usage: mk-env.mjs /tmp/<name> [providerCount=1]  （强制 /tmp 前缀，防误伤真实数据）');
  process.exit(2);
}
const count = Math.max(1, Math.min(4, Number(process.argv[3]) || 1));

const providers = Array.from({ length: count }, (_, i) => {
  const letter = String.fromCharCode(65 + i); // A, B, ...
  return {
    id: `pv-${letter}`,
    name: `Provider ${letter}`,
    api: 'anthropic-messages',
    apiKey: `sk-fake-${letter}`,
    baseUrl: 'http://127.0.0.1:8899',
    enabled: true,
    models: [{ id: 'fake-model-1' }],
  };
});

const state = {
  providers,
  defaultModel: { providerId: 'pv-A', modelId: 'fake-model-1' },
  onboarded: true,
  theme: 'system',
  language: 'zh-CN',
};

mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/settings.json`, JSON.stringify({ 'enso-settings': { state, version: 2 } }));
mkdirSync(`${dir}-proj`, { recursive: true });
writeFileSync(`${dir}-proj/README.md`, 'isolated test project\n');
console.log(`ok: ${dir} (${count} providers) + ${dir}-proj`);
console.log(`next: node scripts/fake-provider-issue-27.mjs &`);
console.log(`      ENSO_USER_DATA_DIR=${dir} pnpm dev`);
