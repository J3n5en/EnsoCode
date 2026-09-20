import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRtk } from './rtk.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = option('--platform', process.platform);
const arch = option('--arch', process.arch);
const binary = await prepareRtk({ root, platform, arch });
process.stdout.write(`RTK ready: ${binary}\n`);
