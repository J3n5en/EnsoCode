import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPathExt = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/**
 * 只接受 dist 的严格子目录，并拒绝 Windows 会重新解释的特殊路径片段。
 *
 * Accept only strict descendants of dist and reject special path segments reinterpreted by Windows.
 */
export function parseBuildOptions(args, root, now = new Date()) {
  let requested = `dist/win-local-${now.toISOString().replace(/[:.]/g, '-')}`;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('--')) {
      throw new Error('Usage: node scripts/build-win-local.mjs [--output dist/<directory>]');
    }
    requested = args[1];
  }
  const segments = requested.replace(/^[A-Za-z]:[\\/]/, '').split(/[\\/]/);
  if (
    segments.some(
      (segment) =>
        (segment !== '.' && segment !== '..' && /[. ]$/.test(segment)) ||
        /[<>:"|?*]/.test(segment) ||
        [...segment].some((character) => character.charCodeAt(0) < 32) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    )
  ) {
    throw new Error('Output contains an invalid Windows path segment');
  }
  const output = path.resolve(root, requested);
  const relative = path.relative(path.join(root, 'dist'), output);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Output must be a directory strictly inside the repository dist directory');
  }
  return { output };
}

/**
 * collector 通过 PowerShell 调用 pnpm.CMD，缺少 PATHEXT 会导致空输出。
 * 仅修复子进程环境副本；Windows 环境键不区分大小写，重复键只保留首个非空值。
 *
 * The collector invokes pnpm.CMD through PowerShell; missing PATHEXT causes empty output.
 * Repair only a child environment copy; Windows keys are case insensitive, keeping the first nonempty value.
 */
export function createBuildEnvironment(environment, nodeDirectory, shimDirectory) {
  const env = { ...environment };
  for (const name of ['PATH', 'PATHEXT']) {
    const keys = Object.keys(env).filter((key) => key.toUpperCase() === name);
    const key = keys[0] ?? name;
    const value = keys.map((entry) => env[entry]).find((entry) => entry?.trim()) ?? '';
    for (const duplicate of keys) delete env[duplicate];
    env[key] =
      name === 'PATH'
        ? [shimDirectory, nodeDirectory, value].filter(Boolean).join(';')
        : value || defaultPathExt;
  }
  return env;
}

/**
 * 拒绝覆盖旧安装包或已打包应用；允许调用器预建目录写入本次日志。
 *
 * Reject existing installers or packaged applications while allowing callers to create a directory for build logs.
 */
export function assertBuildArtifactsAbsent(output, version) {
  for (const name of [`EnsoCode-Setup-${version}.exe`, 'win-unpacked']) {
    if (existsSync(path.join(output, name))) {
      throw new Error('Build artifacts already exist; choose a new output directory');
    }
  }
}

function checkOutputLinks(root, output) {
  let current = root;
  for (const segment of path.relative(root, output).split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Output ancestors must be real directories, without symlinks or junctions');
      }
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
}

function findCorepack(root, nodeDirectory, env) {
  const adjacent = path.join(nodeDirectory, 'node_modules/corepack/dist/corepack.js');
  if (existsSync(adjacent)) return adjacent;
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('corepack/dist/corepack.js', { paths: [nodeDirectory, root] });
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED')
      throw error;
  }
  const located = spawnSync('where.exe', ['corepack.cmd'], {
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (located.status === 0) {
    for (const command of located.stdout.trim().split(/\r?\n/)) {
      const entry = path.join(path.dirname(command), 'node_modules/corepack/dist/corepack.js');
      if (existsSync(entry)) return entry;
    }
  }
  throw new Error(
    'Cannot locate the installed Corepack Node entry; install Corepack before building'
  );
}

function runNode(entry, args, root, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else {
        const error = new Error(`${path.basename(entry)} failed (${signal ?? code})`);
        error.exitCode = code ?? 1;
        reject(error);
      }
    });
  });
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This local packaging entry requires Windows');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { output } = parseBuildOptions(process.argv.slice(2), root);
  checkOutputLinks(root, output);
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assertBuildArtifactsAbsent(output, version);
  const nodeDirectory = path.dirname(process.execPath);
  const env = createBuildEnvironment(process.env, nodeDirectory);
  env.COREPACK_ENABLE_NETWORK = '0';
  const corepack = findCorepack(root, nodeDirectory, env);
  const vite = path.join(root, 'node_modules/electron-vite/bin/electron-vite.js');
  const builder = path.join(root, 'node_modules/electron-builder/cli.js');
  if (!existsSync(vite) || !existsSync(builder)) {
    throw new Error(
      'Missing local build dependencies; restore project dependencies before building'
    );
  }
  const shimDirectory = await mkdtemp(path.join(tmpdir(), 'enso-win-pnpm-'));
  try {
    await runNode(corepack, ['enable', '--install-directory', shimDirectory, 'pnpm'], root, env);
    const buildEnv = createBuildEnvironment(process.env, nodeDirectory, shimDirectory);
    buildEnv.COREPACK_ENABLE_NETWORK = '0';
    buildEnv.NODE_ENV = 'production';
    console.log(`Windows local build output: ${output}`);
    await runNode(vite, ['build', '--mode', 'production'], root, buildEnv);
    checkOutputLinks(root, output);
    assertBuildArtifactsAbsent(output, version);
    await runNode(
      builder,
      ['--win', 'nsis', '--x64', '--publish', 'never', `--config.directories.output=${output}`],
      root,
      buildEnv
    );
    const installer = path.join(output, `EnsoCode-Setup-${version}.exe`);
    if (!statSync(installer).isFile() || statSync(installer).size === 0) {
      throw new Error('The build did not produce a nonempty Windows installer');
    }
    console.log(`Windows installer ready: ${installer}`);
  } finally {
    await rm(shimDirectory, { recursive: true, force: true }).catch((error) => {
      console.error(`Failed to clean temporary pnpm shim: ${error.message}`);
      process.exitCode = 1;
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  });
}
