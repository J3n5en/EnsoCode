import { existsSync } from 'node:fs';
import os from 'node:os';
import { agyChildEnv, agyCommandArgs, agyOnPath, resolveAgyBinary } from './launch';
import { agySessionFor } from './registry';
import { type AgyHostMcp, type AgySession, openAgySession } from './session';
import { getAgyWorkerConfig } from './workerConfig';

type Opener = typeof openAgySession;
let opener: Opener = openAgySession;

export function setAgySessionOpener(next: Opener | undefined): void {
  opener = next ?? openAgySession;
}

export function openBoundAgySession(input: {
  ensoSessionId: string;
  cwd: string;
  readRoots: readonly string[];
  clientVersion: string;
  resumeSessionId?: string;
  hostMcp?: AgyHostMcp;
  systemAppend?: string;
}): Promise<AgySession> {
  const config = getAgyWorkerConfig();
  const binary = resolveAgyBinary({
    configured: config.binaryPath,
    pathHit: agyOnPath(),
    home: os.homedir(),
    exists: existsSync,
  });
  if (!binary)
    throw new Error('agy is not installed. Install the Antigravity CLI and detect again.');
  // agy 只在 session/new、session/resume 时拉一次 MCP 工具表：Enso 工具集一变就换进程 resume。
  // systemAppend 不进 key：中途变了由 session 随下一轮指令重发，不为它换进程
  const tools = input.hostMcp?.tools.join(',') ?? '';
  return agySessionFor(input.ensoSessionId, `${binary}\0${config.skipPermissions}\0${tools}`, () =>
    opener({
      command: binary,
      args: agyCommandArgs(config.skipPermissions),
      cwd: input.cwd,
      env: agyChildEnv(process.env),
      clientVersion: input.clientVersion,
      readRoots: input.readRoots,
      resumeSessionId: input.resumeSessionId,
      ...(input.hostMcp ? { hostMcp: input.hostMcp } : {}),
      ...(input.systemAppend !== undefined ? { systemAppend: input.systemAppend } : {}),
    })
  );
}
