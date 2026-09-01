import { describe, expect, it } from 'vitest';
import { isCursorH2BridgeSpawn } from './installHook';

describe('isCursorH2BridgeSpawn', () => {
  it('matches the real bridge script path, not a bash -c that merely mentions it', () => {
    expect(
      isCursorH2BridgeSpawn('node', ['/pkg/node_modules/@rahularya01/pi-cursor/h2-bridge.mjs'])
    ).toBe(true);
    expect(isCursorH2BridgeSpawn('/pkg/h2-bridge.js', { cwd: '/tmp' })).toBe(true);

    expect(
      isCursorH2BridgeSpawn('/bin/bash', ['-c', 'cd /tmp && grep -c "h2-bridge" dist/index.js'])
    ).toBe(false);
    expect(
      isCursorH2BridgeSpawn('/bin/bash', ['-c', 'git commit -m "子进程 h2-bridge 已删除"'])
    ).toBe(false);
  });
});
