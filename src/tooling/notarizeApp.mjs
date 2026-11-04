import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// stapler 向 api.apple-cloudkit.com 取票据，CI 上偶发 -1005 断连（Error 68）；只重试这一步
export const STAPLE_DELAYS = [15_000, 30_000, 60_000, 60_000, 60_000];

const defaults = {
  exec: promisify(execFile),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delays: STAPLE_DELAYS,
  log: (message) => console.log(`  • ${message}`),
};

export function notaryCredentials(env) {
  const { APPLE_ID: appleId, APPLE_APP_SPECIFIC_PASSWORD: password, APPLE_TEAM_ID: teamId } = env;
  return appleId && password && teamId ? { appleId, password, teamId } : null;
}

export function shouldNotarize(context) {
  return (
    context.electronPlatformName === 'darwin' &&
    context.targets.some((target) => target.name !== 'dir')
  );
}

function authArgs({ appleId, password, teamId }) {
  return ['--apple-id', appleId, '--password', password, '--team-id', teamId];
}

async function submit(appPath, creds, exec) {
  const dir = await mkdtemp(path.join(tmpdir(), 'enso-notarize-'));
  const zip = path.join(dir, `${path.basename(appPath, '.app')}.zip`);
  try {
    await exec('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zip]);
    const args = [
      'notarytool',
      'submit',
      zip,
      ...authArgs(creds),
      '--wait',
      '--output-format',
      'json',
    ];
    // 结果非 Accepted 时 notarytool 也可能非零退出，JSON 仍在 stdout
    const stdout = await exec('xcrun', args, { maxBuffer: 16 * 1024 * 1024 }).then(
      (result) => result.stdout,
      (error) => {
        if (typeof error?.stdout === 'string' && error.stdout.trim()) return error.stdout;
        throw error;
      }
    );
    return JSON.parse(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function notarizeApp(appPath, creds, options = {}) {
  const { exec, sleep, delays, log } = { ...defaults, ...options };
  log(`notarizing ${path.basename(appPath)}`);
  const result = await submit(appPath, creds, exec);
  if (result.status !== 'Accepted') {
    const detail = result.id
      ? await exec('xcrun', ['notarytool', 'log', result.id, ...authArgs(creds)]).then(
          (r) => r.stdout,
          (error) => String(error)
        )
      : '';
    throw new Error(
      `Notarization ${result.status ?? 'failed'} (${result.id ?? 'no id'})\n${detail}`
    );
  }
  const cwd = path.dirname(appPath);
  const name = path.basename(appPath);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await exec('xcrun', ['stapler', 'staple', '-v', name], { cwd });
      break;
    } catch (error) {
      if (attempt >= delays.length) throw error;
      log(`staple failed, retry ${attempt + 1}/${delays.length} in ${delays[attempt] / 1000}s`);
      await sleep(delays[attempt]);
    }
  }
  await exec('xcrun', ['stapler', 'validate', name], { cwd });
  log('notarization stapled');
}
