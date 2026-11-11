import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import {
  ELEVATE_DECLINED_MARKER,
  ELEVATE_TIMED_OUT_MARKER,
  ELEVATE_UNAVAILABLE_MARKER,
  type ElevationOutcome,
  elevatedCommandOf,
} from '@shared/elevation';
import { shellQuote } from '@shared/ssh';
import type { ElevationBroker } from './broker';

export interface ElevationProcessInfo {
  ppid: number;
  comm: string;
  args: string;
}
export type InspectProcess = (pid: number) => Promise<ElevationProcessInfo | null>;

const MAX_REQUEST = 4096;

function psField(pid: number, field: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], (error, stdout) =>
      resolve(error ? null : stdout.replace(/\n+$/, ''))
    );
  });
}

export const inspectProcess: InspectProcess = async (pid) => {
  const [ppid, comm, args] = await Promise.all([
    psField(pid, 'ppid'),
    psField(pid, 'comm'),
    psField(pid, 'args'),
  ]);
  if (ppid === null || comm === null || args === null) return null;
  return { ppid: Number(ppid.trim()), comm: comm.trim(), args };
};

function helperSource(socketPath: string, token: string): string {
  const marks = {
    declined: ELEVATE_DECLINED_MARKER,
    timeout: ELEVATE_TIMED_OUT_MARKER,
    unavailable: ELEVATE_UNAVAILABLE_MARKER,
  };
  // 别在 Main 源码里写字面量 require 调用：electron-vite 会因此给 main chunk 注入 CJS shim，
  // 并按正则找“最后一条 import”定位插入点，会误落进 i18n 文案里把产物截断
  return `'use strict';
// EnsoCode sudo askpass：向 Main 要口令，只经 stdout 交给 sudo
const load = require;
const net = load('node:net');
const MARKS = ${JSON.stringify(marks)};
let done = false;
const fail = (kind) => {
  if (done) return;
  done = true;
  process.stderr.write((MARKS[kind] || MARKS.declined) + '\\n');
  process.exit(1);
};
const socket = net.connect(${JSON.stringify(socketPath)}, () =>
  socket.write(JSON.stringify({ token: ${JSON.stringify(token)}, pid: process.pid }) + '\\n')
);
let buf = '';
socket.setEncoding('utf8');
socket.on('data', (chunk) => { buf += chunk; });
socket.on('end', () => {
  let reply = null;
  try { reply = JSON.parse(buf); } catch {}
  if (reply && reply.kind === 'password' && typeof reply.password === 'string') {
    done = true;
    process.stdout.write(reply.password + '\\n', () => process.exit(0));
    return;
  }
  fail(reply && reply.kind);
});
socket.on('error', () => fail('unavailable'));
`;
}

export interface ElevationServer {
  askpassPath: string;
  /** socket 开始监听；失败时 helper 连不上，按 unavailable 收尾 */
  ready: Promise<void>;
  close(): void;
}

/**
 * askpass 服务：sudo 拉起 helper → helper 带 token 连本 socket → 核对它确是 sudo 的子进程、
 * sudo argv 是 Enso 拼出的格式 → 交给 broker 等用户应答 → 把结果写回 helper。
 * Node 拿不到 peercred，同用户进程的冒用只能靠 token 文件权限与重复请求互斥缓解。
 */
export function startElevationServer(options: {
  dir: string;
  broker: ElevationBroker;
  execPath: string;
  inspect?: InspectProcess;
}): ElevationServer {
  const { dir, broker } = options;
  const inspect = options.inspect ?? inspectProcess;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const socketPath = path.join(dir, 's.sock');
  const cjsPath = path.join(dir, 'askpass.cjs');
  const askpassPath = path.join(dir, 'askpass');
  const token = randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(token);
  rmSync(socketPath, { force: true });
  writeFileSync(cjsPath, helperSource(socketPath, token), { mode: 0o600 });
  writeFileSync(
    askpassPath,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(options.execPath)} ${shellQuote(cjsPath)} "$@"\n`,
    { mode: 0o700 }
  );
  chmodSync(cjsPath, 0o600);
  chmodSync(askpassPath, 0o700);

  const tokenOk = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    const bytes = Buffer.from(value);
    return bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes);
  };

  const serve = async (line: string, socket: Socket): Promise<ElevationOutcome> => {
    const declined: ElevationOutcome = { kind: 'declined' };
    let message: { token?: unknown; pid?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      return declined;
    }
    if (!tokenOk(message?.token)) return declined;
    const helperPid = message.pid;
    if (typeof helperPid !== 'number' || !Number.isInteger(helperPid) || helperPid <= 1) {
      return declined;
    }
    const helper = await inspect(helperPid);
    if (!helper?.args.includes(cjsPath) || helper.ppid <= 1) return declined;
    const sudo = await inspect(helper.ppid);
    if (!sudo || path.basename(sudo.comm) !== 'sudo') return declined;
    const command = elevatedCommandOf(sudo.args);
    if (command === null) return declined;
    if (socket.destroyed) return declined;
    const { id, outcome } = broker.request({ command, sudoPid: helper.ppid, helperPid });
    if (id) socket.once('close', () => broker.cancel(id));
    return outcome;
  };

  const server = createServer((socket) => {
    let buf = '';
    let started = false;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk: string) => {
      if (started) return;
      buf += chunk;
      if (buf.length > MAX_REQUEST) {
        socket.destroy();
        return;
      }
      const newline = buf.indexOf('\n');
      if (newline < 0) return;
      started = true;
      const reply = (outcome: ElevationOutcome) => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(outcome)}\n`);
      };
      serve(buf.slice(0, newline), socket).then(reply, () => reply({ kind: 'declined' }));
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      chmodSync(socketPath, 0o600);
      resolve();
    });
  });

  return {
    askpassPath,
    ready,
    close: () => {
      broker.declineAll();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
