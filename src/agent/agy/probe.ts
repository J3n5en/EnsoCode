import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyAuthProbe, isSignedOutError } from '@shared/agy/catalog';
import { AGY_MIN_VERSION } from '@shared/agy/constants';
import type { AgyAuthStatus } from '@shared/agy/types';
import { agyVersionAtLeast } from '@shared/agy/version';
import { AgyRpcError } from './connection';
import { startAgyProcess } from './process';
import { parseInitialize, parseSessionSetup } from './protocol';

/** 临时目录里 initialize + session/new，然后杀掉进程。不调用 authenticate。 */
export async function probeAgyAuth(options: {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  clientVersion: string;
  timeoutMs?: number;
}): Promise<AgyAuthStatus> {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'agy-probe-')));
  const proc = startAgyProcess({
    command: options.command,
    args: options.args,
    cwd,
    env: options.env ?? process.env,
  });
  const timeout = options.timeoutMs ?? 15_000;
  try {
    const init = await proc.rpc.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'enso-code', title: 'EnsoCode', version: options.clientVersion },
      },
      AbortSignal.timeout(timeout)
    );
    const parsed = parseInitialize(init);
    if (!parsed || !agyVersionAtLeast(parsed.version, AGY_MIN_VERSION)) {
      return classifyAuthProbe({ found: true, version: parsed?.version, timedOut: !parsed });
    }
    try {
      const result = await proc.rpc.request(
        'session/new',
        { cwd, mcpServers: [] },
        AbortSignal.timeout(timeout)
      );
      const setup = parseSessionSetup(result);
      return classifyAuthProbe({
        found: true,
        version: parsed.version,
        sessionId: setup?.sessionId,
        result,
      });
    } catch (error) {
      if (error instanceof AgyRpcError && isSignedOutError(error.code, error.message)) {
        return classifyAuthProbe({
          found: true,
          version: parsed.version,
          errorCode: error.code,
          errorMessage: error.message,
        });
      }
      if (error instanceof Error && error.name === 'TimeoutError') {
        return { status: 'unknown' };
      }
      return { status: 'unknown' };
    }
  } catch (error) {
    if (error instanceof AgyRpcError && isSignedOutError(error.code, error.message)) {
      return { status: 'signed-out', version: '' };
    }
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return { status: 'unknown' };
    }
    return { status: 'unknown' };
  } finally {
    await proc.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
}
