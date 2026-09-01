import type { SpawnOptions } from 'node:child_process';
import * as nodeModule from 'node:module';
import { startCursorH2Bridge } from './h2Bridge';
import { handlePiCursorExec, handlePiCursorInteraction } from './sessionBridge';

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

/** Ju/hi 挂本进程；pi-cursor 的 h2-bridge spawn 改成进程内 HTTP/2。 */
export function installPiCursorExecHook(): void {
  wrapSpawnWithInProcessH2();
  globalThis.__ensoCursorHandleExec = (execCase, execMsg, write) =>
    handlePiCursorExec(execCase, execMsg, write);
  globalThis.__ensoCursorHandleInteraction = (query, write) =>
    handlePiCursorInteraction(query, write);
}

let spawnWrapped = false;

function spawnArgBasename(arg: string): string {
  const trimmed = arg.replace(/\\/g, '/');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** 只认真正的桥脚本名，bash -c 里提到这个词不算。 */
export function isCursorH2BridgeSpawn(
  command: string,
  args?: readonly string[] | SpawnOptions
): boolean {
  const argv = [command, ...(Array.isArray(args) ? args : [])];
  return argv.some((arg) => {
    if (typeof arg !== 'string') return false;
    const name = spawnArgBasename(arg);
    return name === 'h2-bridge' || name === 'h2-bridge.mjs' || name === 'h2-bridge.js';
  });
}

function wrapSpawnWithInProcessH2(): void {
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
    if (isCursorH2BridgeSpawn(command, args)) {
      return startCursorH2Bridge() as unknown as ReturnType<typeof original>;
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
