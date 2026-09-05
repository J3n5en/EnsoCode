import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('pi-cursor pnpm patch', () => {
  it('keeps Enso exec/interaction hooks on the installed 1.4.31 bundle', () => {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve('@rahularya01/pi-cursor/package.json');
    const { version } = JSON.parse(readFileSync(pkgJson, 'utf8')) as { version: string };
    expect(version).toBe('1.4.31');
    const bundle = readFileSync(require.resolve('@rahularya01/pi-cursor'), 'utf8');
    expect(bundle).toContain('__ensoCursorHandleInteraction');
    expect(bundle).toContain('__ensoCursorHandleExec');
  });

  it('retries Connect not_found by rotating the Cursor conversation id', () => {
    const require = createRequire(import.meta.url);
    const bundle = readFileSync(require.resolve('@rahularya01/pi-cursor'), 'utf8');
    expect(bundle).toMatch(/\\bnot_found\\b/);
    expect(bundle).toContain('kind==="conversation_not_found"');
    expect(bundle).toContain('kind:"conversation_not_found"');
  });
});
