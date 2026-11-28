import { describe, expect, it } from 'vitest';
import { agyChildEnv, agyCommandArgs, resolveAgyBinary } from './launch';

describe('agy launch', () => {
  it('uses the spec args and does not override a user auto-update setting', () => {
    expect(agyCommandArgs(false)).toEqual(['acp', '--disable-telemetry']);
    expect(agyCommandArgs(true)).toEqual([
      'acp',
      '--disable-telemetry',
      '--dangerously-skip-permissions',
    ]);
    expect(agyChildEnv({ AGY_CLI_DISABLE_AUTO_UPDATE: 'false', PATH: '/bin' })).toMatchObject({
      AGY_CLI_DISABLE_AUTO_UPDATE: 'false',
    });
    expect(agyChildEnv({ PATH: '/bin' }).AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
  });

  // `agy acp --agent <x>` 让 agy 把请求记成 custom_agent（调研称按 4× 计配额）。会话和探测都只从这里取参数。
  it('never selects a custom agent', () => {
    for (const skip of [false, true]) {
      expect(
        agyCommandArgs(skip).some((arg) => arg === '--agent' || arg.startsWith('--agent='))
      ).toBe(false);
    }
  });

  it('prefers a configured binary, then PATH, then ~/.local/bin/agy', () => {
    const exists = (target: string) =>
      target === '/opt/agy' || target === '/usr/bin/agy' || target === '/home/u/.local/bin/agy';
    expect(resolveAgyBinary({ configured: '/opt/agy', exists })).toBe('/opt/agy');
    expect(resolveAgyBinary({ configured: '/missing', pathHit: '/usr/bin/agy', exists })).toBe(
      '/usr/bin/agy'
    );
    expect(resolveAgyBinary({ home: '/home/u', exists })).toBe('/home/u/.local/bin/agy');
    expect(resolveAgyBinary({ home: '/home/u', exists: () => false })).toBeUndefined();
  });
});
