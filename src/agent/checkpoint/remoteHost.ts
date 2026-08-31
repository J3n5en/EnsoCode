/**
 * CheckpointHost 的 ssh 实现:git 经 `env <覆盖项> git <args>` 在远端 repo 执行,
 * 未跟踪路径批量 stat 一次往返,临时 index 目录用远端 mktemp。
 */

import { posix } from 'node:path';
import { shellQuote } from '@shared/ssh';
import type { SshExecutor } from '../ssh/executor';
import { type CheckpointHost, parseArgs } from './core';

/** 批量 stat 脚本:stdin 每行一个相对路径,输出 `kind size path`(d/f/m) */
// $((...)) 算术展开顺手吃掉 wc 输出的前导空白(macOS 远端也安全)
const STAT_BATCH_SCRIPT = [
  'while IFS= read -r p; do',
  `if [ -d "$p" ]; then printf 'd 0 %s\\n' "$p";`,
  `elif [ -f "$p" ]; then printf 'f %s %s\\n' "$(($(wc -c < "$p")))" "$p";`,
  `else printf 'm 0 %s\\n' "$p"; fi;`,
  'done',
].join(' ');

export function createRemoteCheckpointHost(executor: SshExecutor): CheckpointHost {
  return {
    async git(cmd, cwd, opts = {}) {
      const envPairs = Object.entries(opts.env ?? {}).map(([key, value]) => `${key}=${value}`);
      const argv =
        envPairs.length > 0
          ? ['env', ...envPairs, 'git', ...parseArgs(cmd)]
          : ['git', ...parseArgs(cmd)];
      const result = await executor.exec(argv, {
        cwd,
        ...(opts.input !== undefined ? { stdin: Buffer.from(opts.input, 'utf8') } : {}),
      });
      if (result.code !== 0) {
        throw new Error(result.stderr || `git ${parseArgs(cmd)[0]} failed (code ${result.code})`);
      }
      return result.stdout.trim();
    },

    async statBatch(root, paths) {
      const map = new Map<string, { kind: 'file' | 'dir' | 'missing'; size: number }>();
      if (paths.length === 0) return map;
      const result = await executor.exec(`cd ${shellQuote(root)} && ${STAT_BATCH_SCRIPT}`, {
        stdin: Buffer.from(`${paths.join('\n')}\n`, 'utf8'),
      });
      for (const line of result.stdout.split('\n')) {
        if (!line) continue;
        const kindChar = line[0];
        const rest = line.slice(2);
        const sp = rest.indexOf(' ');
        if (sp === -1) continue;
        const size = Number(rest.slice(0, sp)) || 0;
        const path = rest.slice(sp + 1);
        map.set(path, {
          kind: kindChar === 'd' ? 'dir' : kindChar === 'f' ? 'file' : 'missing',
          size,
        });
      }
      return map;
    },

    async mkdtemp() {
      const result = await executor.exec(['mktemp', '-d', '/tmp/enso-checkpoint-XXXXXX']);
      if (result.code !== 0 || !result.stdout.trim()) {
        throw new Error(result.stderr || 'remote mktemp failed');
      }
      return result.stdout.trim();
    },

    async rmrf(path) {
      await executor.exec(['rm', '-rf', '--', path]).catch(() => {});
    },

    join: (...parts) => posix.join(...parts),
  };
}
