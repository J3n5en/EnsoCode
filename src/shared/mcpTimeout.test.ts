import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  MAX_MCP_CALL_TIMEOUT_SEC,
  MAX_MCP_CONNECT_TIMEOUT_SEC,
  mcpTimeoutsForSpawn,
  parseMcpTimeoutSec,
  resolveMcpTimeoutMs,
} from './mcpTimeout';

describe('parseMcpTimeoutSec', () => {
  it('接受正整数秒', () => {
    expect(parseMcpTimeoutSec(30)).toBe(30);
    expect(parseMcpTimeoutSec('45')).toBe(45);
  });

  it('空、非法、非正、非整数一律视为未设置', () => {
    expect(parseMcpTimeoutSec(undefined)).toBeUndefined();
    expect(parseMcpTimeoutSec(null)).toBeUndefined();
    expect(parseMcpTimeoutSec('')).toBeUndefined();
    expect(parseMcpTimeoutSec('  ')).toBeUndefined();
    expect(parseMcpTimeoutSec(0)).toBeUndefined();
    expect(parseMcpTimeoutSec(-1)).toBeUndefined();
    expect(parseMcpTimeoutSec(1.5)).toBeUndefined();
    expect(parseMcpTimeoutSec('1.5')).toBeUndefined();
    expect(parseMcpTimeoutSec('abc')).toBeUndefined();
  });

  it('按种类封顶', () => {
    expect(parseMcpTimeoutSec(9999, MAX_MCP_CONNECT_TIMEOUT_SEC)).toBe(MAX_MCP_CONNECT_TIMEOUT_SEC);
    expect(parseMcpTimeoutSec(9999, MAX_MCP_CALL_TIMEOUT_SEC)).toBe(MAX_MCP_CALL_TIMEOUT_SEC);
  });
});

describe('resolveMcpTimeoutMs', () => {
  it('缺省与脏值回落到 fallback', () => {
    expect(resolveMcpTimeoutMs(undefined, DEFAULT_MCP_CONNECT_TIMEOUT_MS)).toBe(
      DEFAULT_MCP_CONNECT_TIMEOUT_MS
    );
    expect(resolveMcpTimeoutMs(0, DEFAULT_MCP_CALL_TIMEOUT_MS)).toBe(DEFAULT_MCP_CALL_TIMEOUT_MS);
    expect(resolveMcpTimeoutMs(-3, 1_000)).toBe(1_000);
    expect(resolveMcpTimeoutMs('nope', 2_000)).toBe(2_000);
  });

  it('正整数秒转毫秒并封顶', () => {
    expect(
      resolveMcpTimeoutMs(15, DEFAULT_MCP_CONNECT_TIMEOUT_MS, MAX_MCP_CONNECT_TIMEOUT_SEC)
    ).toBe(15_000);
    expect(
      resolveMcpTimeoutMs(9999, DEFAULT_MCP_CONNECT_TIMEOUT_MS, MAX_MCP_CONNECT_TIMEOUT_SEC)
    ).toBe(MAX_MCP_CONNECT_TIMEOUT_SEC * 1000);
  });
});

describe('mcpTimeoutsForSpawn', () => {
  it('默认不带字段', () => {
    expect(mcpTimeoutsForSpawn({})).toEqual({});
    expect(mcpTimeoutsForSpawn({ connectTimeoutSec: 10, callTimeoutSec: 120 })).toEqual({});
  });

  it('仅覆盖非默认值', () => {
    expect(mcpTimeoutsForSpawn({ connectTimeoutSec: 30, callTimeoutSec: 600 })).toEqual({
      connectTimeoutMs: 30_000,
      callTimeoutMs: 600_000,
    });
    expect(mcpTimeoutsForSpawn({ connectTimeoutSec: 10, callTimeoutSec: 90 })).toEqual({
      callTimeoutMs: 90_000,
    });
  });
});
