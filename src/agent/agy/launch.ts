import { existsSync } from 'node:fs';
import path from 'node:path';

export function agyCommandArgs(skipPermissions: boolean): string[] {
  const args = ['acp', '--disable-telemetry'];
  if (skipPermissions) args.push('--dangerously-skip-permissions');
  return args;
}

export function agyChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    AGY_CLI_DISABLE_AUTO_UPDATE: base.AGY_CLI_DISABLE_AUTO_UPDATE ?? 'true',
  };
}

export function resolveAgyBinary(input: {
  configured?: string;
  pathHit?: string;
  home?: string;
  exists: (target: string) => boolean;
}): string | undefined {
  const configured = input.configured?.trim();
  if (configured && input.exists(configured)) return configured;
  if (input.pathHit && input.exists(input.pathHit)) return input.pathHit;
  if (!input.home) return undefined;
  const fallback = path.join(input.home, '.local', 'bin', 'agy');
  return input.exists(fallback) ? fallback : undefined;
}

export function agyOnPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'agy');
    if (existsSync(candidate)) return candidate;
    if (process.platform === 'win32' && existsSync(`${candidate}.exe`)) return `${candidate}.exe`;
  }
  return undefined;
}
