import { readFileSync } from 'node:fs';
import { ENSO_HEADLESS_RUN_ENV } from '@shared/headlessRun';
import { parseRunArgs, RUN_USAGE } from './args';
import { executeRun } from './execute';

/** 诊断改走 stderr，业务输出只经调用方保存的 stdout。 */
function captureStdout(): (chunk: string) => void {
  const write = process.stdout.write.bind(process.stdout);
  const writeStderr = process.stderr.write.bind(process.stderr);
  const redirect = (...args: unknown[]) => {
    const text = args.map((item) => (typeof item === 'string' ? item : String(item))).join(' ');
    writeStderr(`${text}\n`);
  };
  console.log = redirect;
  console.info = redirect;
  console.debug = redirect;
  return (chunk) => {
    write(chunk);
  };
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseRunArgs(argv);
  if (!parsed.ok) {
    if (parsed.help) {
      process.stdout.write(`${RUN_USAGE}\n`);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n${RUN_USAGE}\n`);
    return 2;
  }
  if (parsed.args.dataDir) process.env.ENSO_DATA_DIR = parsed.args.dataDir;
  process.env[ENSO_HEADLESS_RUN_ENV] = '1';
  const writeStdout = captureStdout();
  const controller = new AbortController();
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (signals > 1) process.exit(130);
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    return await executeRun(parsed.args, {
      writeStdout,
      writeStderr: (chunk) => {
        process.stderr.write(chunk);
      },
      readStdin: () => readFileSync(0, 'utf8'),
      signal: controller.signal,
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
