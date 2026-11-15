#!/usr/bin/env npx tsx

/**
 * 记忆库向量表瘦身 / 空间回收脚本。默认 dry-run，只报告会做什么；加 --apply 才真正执行。
 *
 *   npx tsx scripts/memory-compact.ts                 # dry-run，打印估算
 *   npx tsx scripts/memory-compact.ts --apply         # 备份 → 重建向量表 → VACUUM
 *   npx tsx scripts/memory-compact.ts --db <path>     # 指定库文件（默认按平台取 userData/memory/memory.db）
 *
 * 阶段落在 memory_maintenance 表，中断后重跑同一条命令即从断点继续。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openMemoryDb } from '../src/main/services/memory/db';
import { planVecCompaction, runVecCompaction } from '../src/main/services/memory/maintenance';

const APP_DIR = 'enso-code';
const MB = 1024 * 1024;

function defaultDbPath(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_DIR, 'memory', 'memory.db');
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
      APP_DIR,
      'memory',
      'memory.db'
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'),
    APP_DIR,
    'memory',
    'memory.db'
  );
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const apply = process.argv.includes('--apply');
const dbPath = arg('--db') ?? process.env.ENSO_MEMORY_DB ?? defaultDbPath();
const mb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;

if (!fs.existsSync(dbPath)) {
  console.error(`找不到记忆库：${dbPath}`);
  process.exit(1);
}

// 估算必须在迁移「之前」的布局上做：openMemoryDb 会顺带跑 v10 迁移（重建向量表），
// 所以先用只读连接看一眼现状，一个字节都不写。
const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
const before = planVecCompaction(probe);
probe.close();

console.log(`库文件：${dbPath}`);
console.log(`当前体积：${mb(before.dbBytes)}（空闲页 ${mb(before.freeBytes)}）`);
console.log(`向量表：${mb(before.vectorBytes)} → 预计 ${mb(before.projectedVectorBytes)}`);
for (const t of before.tables) {
  console.log(
    `  ${t.name}: ${t.rows} 行 / ${t.chunks} chunk（chunk_size ${t.chunkSize ?? '-'}）→ ${t.projectedChunks} chunk`
  );
}
console.log(`预计可回收：${mb(before.reclaimableBytes)}`);
console.log('计划动作：');
for (const action of before.actions) console.log(`  - ${action}`);

if (!apply) {
  console.log('\n这是 dry-run，没有改动任何文件。加 --apply 执行。');
  process.exit(0);
}

const db = openMemoryDb(dbPath);
const result = runVecCompaction(db, dbPath);
console.log(`\n阶段：${result.resumedFrom} → ${result.phase}`);
if (result.backupPath) console.log(`备份：${result.backupPath}`);
if (result.rebuiltTables.length > 0) console.log(`重建：${result.rebuiltTables.join(', ')}`);
console.log(
  `体积：${mb(result.beforeBytes)} → ${mb(result.afterBytes)}（回收 ${mb(result.reclaimedBytes)}）`
);
db.close();
if (result.error) {
  console.error(`未完成：${result.error}（重跑本命令从断点继续）`);
  process.exit(2);
}
