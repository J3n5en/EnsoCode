import path from 'node:path';
import { fileURLToPath } from 'node:url';
import stripPackagedNatives from '../src/tooling/stripPackagedNatives.mjs';
import { copyRtkDistribution } from './rtk.mjs';

const ARCH_NAME = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function archName(arch) {
  if (typeof arch === 'string') return arch;
  return ARCH_NAME[arch] ?? String(arch);
}

function packagedResourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources'
    );
  }
  return path.join(context.appOutDir, 'resources');
}

export default async function afterPack(context) {
  await stripPackagedNatives(context);
  await copyRtkDistribution(
    root,
    path.join(packagedResourcesDir(context), 'rtk'),
    context.electronPlatformName,
    archName(context.arch)
  );
}
