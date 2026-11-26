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
