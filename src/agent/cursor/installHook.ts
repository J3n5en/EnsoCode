import type { SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { handlePiCursorExec, handlePiCursorInteraction } from './sessionBridge';

const ASAR_DIR = `${path.sep}app.asar${path.sep}`;
const ASAR_UNPACKED_DIR = `${path.sep}app.asar.unpacked${path.sep}`;

declare global {
  // pi-cursor Ju/hi 钩子（pnpm patch）：有会话桥才接管，否则走原 reject
  var __ensoCursorHandleExec:
    | ((
        execCase: string | undefined,
        execMsg: {
          id?: number;
          execId?: string;
          message?: { case?: string; value?: Record<string, unknown> };
        },
        write: (bytes: Uint8Array) => void,
        _emitMcp?: unknown
      ) => boolean | Promise<boolean>)
    | undefined;
  var __ensoCursorHandleInteraction:
    | ((
        query: { id?: number; query?: { case?: string | null } },
        write: (bytes: Uint8Array) => void
      ) => { handled: boolean; action: string; queryCase: string } | false)
    | undefined;
}

/** Ju/hi 入口挂上本进程；h2-bridge 的脚本路径从 asar 改到真实文件。 */
export function installPiCursorExecHook(): void {
  wrapSpawnForH2BridgePath();
  globalThis.__ensoCursorHandleExec = (execCase, execMsg, write) =>
    handlePiCursorExec(execCase, execMsg, write);
  globalThis.__ensoCursorHandleInteraction = (query, write) =>
    handlePiCursorInteraction(query, write);
}

let spawnWrapped = false;
let h2BridgeScript: string | undefined;

function wrapSpawnForH2BridgePath(): void {
  if (spawnWrapped) return;
  spawnWrapped = true;
  const cp = nodeModule.createRequire(import.meta.url)(
    'node:child_process'
  ) as typeof import('node:child_process');
  const original = cp.spawn;
  const wrapped = ((
    command: string,
    args?: readonly string[] | SpawnOptions,
    options?: SpawnOptions
  ) => {
    const argv = Array.isArray(args) ? [...args] : [];
    const isH2 = argv.some((arg) => typeof arg === 'string' && arg.includes('h2-bridge'));
    if (isH2 && process.versions.electron && command === process.execPath) {
      const nextArgs = argv.map((arg) =>
        typeof arg === 'string' && arg.includes('h2-bridge') ? realH2BridgePath(arg) : arg
      );
      return original(command, nextArgs, options ?? {});
    }
    if (Array.isArray(args)) return original(command, args as string[], options ?? {});
    return original(command, (args ?? {}) as SpawnOptions);
  }) as typeof cp.spawn;
  cp.spawn = wrapped;
  try {
    nodeModule.syncBuiltinESMExports();
  } catch {
    // CJS 侧已替换
  }
}

/** Node ESM loader 不能执行 asar 内脚本。 */
function realH2BridgePath(script: string): string {
  if (h2BridgeScript && existsSync(h2BridgeScript)) return h2BridgeScript;
  if (!script.includes(ASAR_DIR) && existsSync(script)) {
    h2BridgeScript = script;
    return script;
  }
  const unpacked = script.replaceAll(ASAR_DIR, ASAR_UNPACKED_DIR);
  if (unpacked !== script && existsSync(unpacked)) {
    h2BridgeScript = unpacked;
    return unpacked;
  }
  const src = existsSync(script) ? script : undefined;
  if (!src) return unpacked !== script ? unpacked : script;
  try {
    const destDir = path.join(process.env.ENSO_AGENT_DATA_DIR || os.tmpdir(), 'cursor-h2-bridge');
    mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, 'h2-bridge.mjs');
    writeFileSync(dest, readFileSync(src));
    h2BridgeScript = dest;
    return dest;
  } catch {
    return unpacked !== script ? unpacked : script;
  }
}
