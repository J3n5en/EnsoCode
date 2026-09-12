import fs from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  extractNpmPackageBins,
  gpuBackendInstallDir,
  hasLlamaAddon,
  isGpuBackendReady,
  npmPackumentUrl,
  selectGpuBackendPackage,
  verifyIntegrity,
} from './gpuBackend';

const require = createRequire(import.meta.url);

const HOOK_SOURCE = `let packages = {};
export function initialize(data) {
  packages = data?.packages ?? {};
}
export async function resolve(specifier, context, nextResolve) {
  const target = packages[specifier];
  if (typeof target === 'string') {
    return { url: target, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;

let hookRegistered = false;

export async function ensureGpuBackend(
  opts: {
    root?: string;
    platform?: NodeJS.Platform;
    arch?: string;
    fetch?: typeof fetch;
    registry?: string;
    version?: string;
    detectGpus?: () => Promise<readonly (string | boolean)[]>;
    hasPackagedAddon?: (name: string) => boolean;
    resolvePackage?: (name: string, dest: string) => void;
  } = {}
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;

  const detect =
    opts.detectGpus ??
    (async () => {
      const mod = await import('node-llama-cpp');
      if (typeof mod.getLlamaGpuTypes !== 'function') return [];
      return mod.getLlamaGpuTypes('supported');
    });
  const selected = selectGpuBackendPackage({
    platform,
    arch,
    supportedGpus: await detect(),
  });
  if (!selected) return;

  const hasAddon = opts.hasPackagedAddon ?? hasPackagedAddon;
  if (hasAddon(selected.name)) return;

  const root = opts.root ?? (await defaultRoot());
  const version = opts.version ?? llamaCppVersion();
  const dest = gpuBackendInstallDir(root, selected.name, version);
  if (!isGpuBackendReady(dest)) {
    try {
      await downloadGpuBackend(selected.name, version, dest, opts);
    } catch (error) {
      const cpu = selectGpuBackendPackage({ platform, arch, supportedGpus: [false] });
      if (!cpu || cpu.name === selected.name) throw error;
      console.warn('[llama] GPU backend download failed, falling back to CPU:', error);
      const cpuDest = gpuBackendInstallDir(root, cpu.name, version);
      if (!isGpuBackendReady(cpuDest)) {
        await downloadGpuBackend(cpu.name, version, cpuDest, opts);
      }
      (opts.resolvePackage ?? registerGpuPackage)(cpu.name, cpuDest);
      return;
    }
  }
  (opts.resolvePackage ?? registerGpuPackage)(selected.name, dest);
}

export function llamaCppVersion(): string {
  return require('node-llama-cpp/package.json').version as string;
}

export function hasPackagedAddon(name: string): boolean {
  try {
    const fromLlama = createRequire(require.resolve('node-llama-cpp'));
    const entry = fromLlama.resolve(name);
    return hasLlamaAddon(path.join(path.dirname(entry), '..', 'bins'));
  } catch {
    return false;
  }
}

async function defaultRoot(): Promise<string> {
  const { app } = await import('electron');
  return path.join(app.getPath('userData'), 'llama-gpu-backends');
}

async function downloadGpuBackend(
  name: string,
  version: string,
  dest: string,
  opts: { fetch?: typeof fetch; registry?: string }
): Promise<void> {
  const registry = (
    opts.registry ??
    process.env.npm_config_registry ??
    'https://registry.npmjs.org'
  ).replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const metaRes = await doFetch(`${npmPackumentUrl(registry, name)}/${version}`);
  if (!metaRes.ok) throw new Error(`gpu backend packument HTTP ${metaRes.status}`);
  const meta = (await metaRes.json()) as { dist?: { tarball?: string; integrity?: string } };
  const tarball = meta.dist?.tarball;
  const integrity = meta.dist?.integrity;
  if (!tarball || !integrity) throw new Error('gpu backend packument missing dist');
  console.warn(`[llama] downloading GPU backend ${name}@${version}`);
  const tarRes = await doFetch(tarball);
  if (!tarRes.ok) throw new Error(`gpu backend tarball HTTP ${tarRes.status}`);
  const body = Buffer.from(await tarRes.arrayBuffer());
  verifyIntegrity(body, integrity);
  extractNpmPackageBins(body, dest);
}

function registerGpuPackage(name: string, dest: string): void {
  if (hookRegistered) return;
  const index = path.join(dest, 'dist', 'index.js');
  if (!fs.existsSync(index)) return;
  const hookPath = path.join(path.dirname(dest), 'resolve-hook.mjs');
  fs.writeFileSync(hookPath, HOOK_SOURCE);
  register(pathToFileURL(hookPath).href, {
    data: { packages: { [name]: pathToFileURL(index).href } },
  });
  hookRegistered = true;
}
