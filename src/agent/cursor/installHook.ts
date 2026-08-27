import * as childProcess from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { handlePiCursorExec, handlePiCursorInteraction } from './sessionBridge';

const JU_NEEDLE = 'function Ju(e,t,n,s){let o=e.message.case,r=wu(o??"",t);';
const JU_PATCH =
  'function Ju(e,t,n,s){let o=e.message.case;if(typeof globalThis.__ensoCursorHandleExec==="function"){const _ensoR=globalThis.__ensoCursorHandleExec(o,e,n,s);if(_ensoR)return _ensoR;}let r=wu(o??"",t);';

const HI_NEEDLE = 'function hi(e,t,n){let o=e.query.case;if(ru(e,mi))return';
const HI_PATCH =
  'function hi(e,t,n){if(typeof globalThis.__ensoCursorHandleInteraction==="function"){const _ensoI=globalThis.__ensoCursorHandleInteraction(e,t);if(_ensoI)return _ensoI;}let o=e.query.case;if(ru(e,mi))return';

const SPAWN_NEEDLE = 'spawn(process.execPath,[Ul],{stdio:["pipe","pipe","pipe"]})';
const SPAWN_PATCH =
  'spawn(process.execPath,[Ul],{stdio:["pipe","pipe","pipe"],env:{...process.env,ELECTRON_RUN_AS_NODE:"1"}})';

declare global {
  // pi-cursor Ju/hi 钩子：有会话桥才接管，否则走原 reject
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

/** 在加载 pi-cursor 前给 Ju/hi 打钩，并把 h2-bridge 从 Electron 二进制改成 Node 模式。 */
export function installPiCursorExecHook(): void {
  wrapSpawnAsNodeForH2Bridge();
  globalThis.__ensoCursorHandleExec = (execCase, execMsg, write) =>
    handlePiCursorExec(execCase, execMsg, write);
  globalThis.__ensoCursorHandleInteraction = (query, write) =>
    handlePiCursorInteraction(query, write);

  const require = createRequire(import.meta.url);
  let file: string;
  try {
    file = require.resolve('@rahularya01/pi-cursor');
  } catch {
    return;
  }
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  let next = src;
  if (!next.includes('__ensoCursorHandleExec') && next.includes(JU_NEEDLE)) {
    next = next.replace(JU_NEEDLE, JU_PATCH);
  }
  if (!next.includes('__ensoCursorHandleInteraction') && next.includes(HI_NEEDLE)) {
    next = next.replace(HI_NEEDLE, HI_PATCH);
  }
  if (!next.includes('ELECTRON_RUN_AS_NODE') && next.includes(SPAWN_NEEDLE)) {
    next = next.replace(SPAWN_NEEDLE, SPAWN_PATCH);
  }
  if (next === src) return;
  try {
    writeFileSync(file, next);
  } catch (error) {
    console.warn('[cursor] could not patch pi-cursor exec hook:', error);
  }
}

let spawnWrapped = false;

function wrapSpawnAsNodeForH2Bridge(): void {
  if (spawnWrapped) return;
  spawnWrapped = true;
  const original = childProcess.spawn;
  const wrapped = ((
    command: string,
    args?: readonly string[] | childProcess.SpawnOptions,
    options?: childProcess.SpawnOptions
  ) => {
    const argv = Array.isArray(args) ? args : [];
    const isH2 = argv.some((arg) => typeof arg === 'string' && arg.includes('h2-bridge'));
    if (isH2 && process.versions.electron && command === process.execPath) {
      const rest = (
        options && typeof options === 'object' ? options : Array.isArray(args) ? {} : args
      ) as childProcess.SpawnOptions;
      const env = { ...process.env, ...rest.env, ELECTRON_RUN_AS_NODE: '1' };
      if (Array.isArray(args)) return original(command, args as string[], { ...rest, env });
      return original(command, { ...rest, env });
    }
    if (Array.isArray(args)) return original(command, args as string[], options ?? {});
    return original(command, (args ?? {}) as childProcess.SpawnOptions);
  }) as typeof childProcess.spawn;
  try {
    Object.defineProperty(childProcess, 'spawn', {
      value: wrapped,
      configurable: true,
      writable: true,
    });
  } catch {
    // ESM child_process.spawn 可能不可写，退回对 pi-cursor 源码的 spawn 补丁
  }
}
