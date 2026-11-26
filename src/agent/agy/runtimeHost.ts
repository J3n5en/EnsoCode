import { existsSync } from 'node:fs';
import os from 'node:os';
import { agyChildEnv, agyCommandArgs, agyOnPath, resolveAgyBinary } from './launch';
import { agySessionFor } from './registry';
import { type AgySession, openAgySession } from './session';
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
  return agySessionFor(input.ensoSessionId, `${binary}\0${config.skipPermissions}`, () =>
    opener({
      command: binary,
      args: agyCommandArgs(config.skipPermissions),
      cwd: input.cwd,
      env: agyChildEnv(process.env),
      clientVersion: input.clientVersion,
      readRoots: input.readRoots,
      resumeSessionId: input.resumeSessionId,
    })
  );
}
