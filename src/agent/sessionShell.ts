import {
  type BashOperations,
  createBashToolDefinition,
  createPowerShellToolDefinition,
} from '@earendil-works/pi-coding-agent';

export type SessionShellKind = 'bash' | 'powershell';

export function resolveSessionShellKind(input: {
  platform: string;
  remote?: boolean;
}): SessionShellKind {
  if (input.remote) return 'bash';
  if (input.platform === 'win32') return 'powershell';
  return 'bash';
}

export function createSessionCommandTool(input: {
  cwd: string;
  platform?: NodeJS.Platform;
  remote?: boolean;
  operations?: BashOperations;
}): ReturnType<typeof createBashToolDefinition> {
  const kind = resolveSessionShellKind({
    platform: input.platform ?? process.platform,
    remote: input.remote,
  });
  const options = input.operations ? { operations: input.operations } : undefined;
  return kind === 'powershell'
    ? createPowerShellToolDefinition(input.cwd, options)
    : createBashToolDefinition(input.cwd, options);
}
