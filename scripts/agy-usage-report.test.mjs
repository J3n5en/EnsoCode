import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isEnsoReason,
  protoFields,
  requestShape,
  requestUsage,
  safetyVerdict,
  tallyMonitorLog,
} from './agy-usage-report.mjs';

const varint = (value) => {
  const bytes = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
};
const num = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const bytes = (field, value) => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(body.length), body]);
};

const LOG = [
  'I1127 17:32:12.78 1618 runner.go:961] Monitor agy_tool_safety FINISHED: triggered=true, reason="unsupported_tool: mcp_enso_enso_tool_call", duration=55µs',
  'I1127 17:32:12.78 1639 llm_monitor.go:636] LLM Monitor sir_flash_lite: Trajectory formatted, length: 450',
  'I1127 17:32:13.97 1636 runner.go:961] Monitor sir_flash_lite FINISHED: triggered=false, reason="routine", duration=1s',
  'I1127 17:32:14.02 1690 runner.go:961] Monitor agy_tool_safety FINISHED: triggered=false, reason="allowed_tool", duration=18µs',
  'I1127 17:32:14.03 1690 llm_monitor.go:636] LLM Monitor sir_flash_lite: Trajectory formatted, length: 999',
  'I1127 17:32:15.00 1700 runner.go:961] Monitor agy_tool_safety FINISHED: triggered=true, reason="unsupported_tool: call_mcp_tool", duration=1µs',
  'I1127 17:32:16.00 1700 runner.go:961] Monitor agy_tool_safety FINISHED: triggered=true, reason="unsupported_tool: edit_file", duration=1µs',
].join('\r\n');

test('counts prechecks per reason and charges the trajectory to the call that triggered it', () => {
  const tally = tallyMonitorLog(LOG);
  assert.deepEqual(tally.reasons, {
    'unsupported_tool: mcp_enso_enso_tool_call': 1,
    'unsupported_tool: call_mcp_tool': 1,
    'unsupported_tool: edit_file': 1,
  });
  assert.equal(tally.skipped, 1);
  // 放行那次后面跟着的 999 不记到任何人头上
  assert.deepEqual(tally.trajectoryChars, { 'unsupported_tool: mcp_enso_enso_tool_call': 450 });
  assert.deepEqual(tallyMonitorLog(''), { skipped: 0, reasons: {}, trajectoryChars: {} });
});

test('tells Enso MCP prechecks from agy native ones', () => {
  assert.equal(isEnsoReason('unsupported_tool: mcp_enso_todo'), true);
  assert.equal(isEnsoReason('unsupported_tool: call_mcp_tool'), true);
  assert.equal(isEnsoReason('unsupported_tool: mcp_github_list'), false);
  assert.equal(isEnsoReason('unsupported_tool: edit_file'), false);
  assert.equal(isEnsoReason('unquoted_shell_operators'), false);
  assert.equal(safetyVerdict('Monitor sir_flash_lite SKIPPED'), undefined);
});

test('reads request usage from a gen_metadata row', () => {
  const usage = Buffer.concat([
    num(1, 1537),
    num(2, 7352),
    num(3, 639),
    num(5, 21940),
    num(9, 410),
  ]);
  const row = bytes(1, Buffer.concat([num(3, 1), bytes(4, usage), bytes(19, 'gemini-4-hydrogen')]));
  assert.deepEqual(requestUsage(Buffer.concat([num(2, 7), row])), {
    model: 'gemini-4-hydrogen',
    input: 7352,
    cached: 21940,
    output: 639,
  });
  // 首个请求没有缓存字段，大于 2^31 的 varint 不能溢出成负数
  const big = bytes(1, bytes(4, Buffer.concat([num(2, 3_000_000_000)])));
  assert.deepEqual(requestUsage(big), { model: '', input: 3_000_000_000, cached: 0, output: 0 });
  assert.equal(requestUsage(bytes(1, num(3, 1))), undefined);
  assert.throws(() => protoFields(Buffer.from([0x0a, 0x05, 0x01])), /truncated/);
});

test('measures the Enso tool declarations and the session append in a full request', () => {
  const tool = (name) => bytes(8, Buffer.concat([bytes(1, name), bytes(2, 'd'.repeat(100))]));
  const request = Buffer.concat([
    bytes(1, 's'.repeat(10_000)),
    tool('read_file'),
    tool('mcp_enso_todo'),
    tool('mcp_enso_subagent'),
  ]);
  const append = Buffer.concat([bytes(1, 'acp_system_prompt'), bytes(2, 'x'.repeat(300))]);
  const shape = requestShape(Buffer.concat([bytes(1, request), bytes(3, append)]));
  assert.equal(shape.ensoToolCount, 2);
  // 每个声明外面套着 1 字节 tag + 1 字节长度，计的是声明本身
  assert.equal(
    shape.ensoTools,
    tool('mcp_enso_todo').length - 2 + tool('mcp_enso_subagent').length - 2
  );
  assert.equal(shape.append, 300);
  assert.equal(requestShape(bytes(1, 'short')), undefined);
});
