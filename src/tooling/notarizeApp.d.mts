export interface NotaryCredentials {
  appleId: string;
  password: string;
  teamId: string;
}

export interface NotarizeOptions {
  exec?: (
    file: string,
    args: string[],
    options?: { cwd?: string; maxBuffer?: number }
  ) => Promise<{ stdout: string }>;
  sleep?: (ms: number) => Promise<void>;
  delays?: number[];
  log?: (message: string) => void;
}

export const STAPLE_DELAYS: number[];

export function notaryCredentials(
  env: Record<string, string | undefined>
): NotaryCredentials | null;

export function shouldNotarize(context: {
  electronPlatformName: string;
  targets: { name: string }[];
}): boolean;

export function notarizeApp(
  appPath: string,
  creds: NotaryCredentials,
  options?: NotarizeOptions
): Promise<void>;
