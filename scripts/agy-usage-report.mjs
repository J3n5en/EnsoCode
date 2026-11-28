#!/usr/bin/env node
// 只读本机 agy 留下的日志和会话库，统计 EnsoCode 调 agy 的开销，不发任何请求、不耗配额。
// 用法：node scripts/agy-usage-report.mjs [--since 2026-11-28T00:00] [--until …] [--json]
// 数据：~/.gemini/antigravity-cli/log/acp-server-*.log（agy 安全预审）与 conversations/*.db（每次模型请求的用量）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFETY = /Monitor agy_tool_safety FINISHED: triggered=(true|false), reason="([^"]*)"/;
const TRAJECTORY = /LLM Monitor sir_flash_lite: Trajectory formatted, length: (\d+)/;
const LOG_TIME = /(\d{8}_\d{6})/;

/** 一行 agy_tool_safety 结果：triggered=true 的那次会接着跑一次 sir_flash_lite 预审 */
export function safetyVerdict(line) {
  const match = SAFETY.exec(line);
  if (!match) return undefined;
  return { triggered: match[1] === 'true', reason: match[2] };
}

/** 预审是不是因 EnsoCode 挂给 agy 的 MCP 工具触发：直调 mcp_enso_*，或经 agy 的 call_mcp_tool 转调 */
export function isEnsoReason(reason) {
  return /unsupported_tool: (mcp_enso_|call_mcp_tool$)/.test(reason);
}

export function tallyMonitorLog(text, tally = newMonitorTally()) {
  let pending;
  for (const line of text.split('\n')) {
    const verdict = safetyVerdict(line);
    if (verdict) {
      pending = verdict.triggered ? verdict.reason : undefined;
      if (pending) tally.reasons[pending] = (tally.reasons[pending] ?? 0) + 1;
      else tally.skipped += 1;
      continue;
    }
    const trajectory = pending && TRAJECTORY.exec(line);
    if (trajectory) {
      tally.trajectoryChars[pending] =
        (tally.trajectoryChars[pending] ?? 0) + Number(trajectory[1]);
      pending = undefined;
    }
  }
  return tally;
}

function newMonitorTally() {
  return { skipped: 0, reasons: {}, trajectoryChars: {} };
}

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let index = offset;
  for (;;) {
    if (index >= buf.length) throw new Error('truncated varint');
    const byte = buf[index++];
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return [value, index];
    shift += 7;
  }
}

/** 不带 schema 的 protobuf 读法：[{ field, value }]，length-delimited 的 value 是 Buffer */
export function protoFields(buf) {
  const fields = [];
  let index = 0;
  while (index < buf.length) {
    const [key, next] = readVarint(buf, index);
    index = next;
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field === 0) throw new Error('bad field');
    if (wire === 0) {
      const [value, after] = readVarint(buf, index);
      fields.push({ field, value });
      index = after;
    } else if (wire === 2) {
      const [length, after] = readVarint(buf, index);
      if (after + length > buf.length) throw new Error('truncated bytes');
      fields.push({ field, value: buf.subarray(after, after + length) });
      index = after + length;
    } else if (wire === 1 || wire === 5) {
      index += wire === 1 ? 8 : 4;
    } else throw new Error(`wire type ${wire}`);
  }
  return fields;
}

const first = (fields, field) => fields.find((entry) => entry.field === field)?.value;

/**
 * gen_metadata 一行 = 一次模型请求。字段号是对照多轮请求推出来的（agy 未公开 schema）：
 * 1.4.2 未命中缓存的输入 token，1.4.5 命中缓存的输入 token，1.4.3 输出 token，1.19 模型名，
 * 1.20 键值对（trajectory_source 等）。
 */
export function requestUsage(blob) {
  const inner = first(protoFields(blob), 1);
  if (!Buffer.isBuffer(inner)) return undefined;
  const fields = protoFields(inner);
  const usage = first(fields, 4);
  if (!Buffer.isBuffer(usage)) return undefined;
  const counts = protoFields(usage);
  const number = (field) => {
    const value = first(counts, field);
    return typeof value === 'number' ? value : 0;
  };
  const model = first(fields, 19);
  return {
    model: Buffer.isBuffer(model) ? model.toString('utf8') : '',
    input: number(2),
    cached: number(5),
    output: number(3),
  };
}

/** 带完整请求的那行：EnsoCode 的 session 级 append 与 mcp_enso_* 工具声明各多少字节 */
export function requestShape(blob) {
  const request = first(protoFields(blob), 1);
  if (!Buffer.isBuffer(request) || request.length < 10_000) return undefined;
  let ensoTools = 0;
  let ensoToolCount = 0;
  for (const entry of protoFields(request)) {
    if (entry.field !== 8 || !Buffer.isBuffer(entry.value)) continue;
    const name = first(protoFields(entry.value), 1);
    if (Buffer.isBuffer(name) && name.toString('utf8').startsWith('mcp_enso_')) {
      ensoTools += entry.value.length;
      ensoToolCount += 1;
    }
  }
  const marker = blob.indexOf('acp_system_prompt');
  const append = marker < 0 ? 0 : readVarint(blob, marker + 'acp_system_prompt'.length + 1)[0];
  return { ensoTools, ensoToolCount, append };
}

function conversationStats(file) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const requests = [];
    let shape;
    for (const row of db.prepare('SELECT data FROM gen_metadata ORDER BY idx').iterate()) {
      const blob = Buffer.from(row.data);
      try {
        const usage = requestUsage(blob);
        if (usage) requests.push(usage);
        shape ??= requestShape(blob);
      } catch {
        // 认不出的行跳过，不让一行坏数据挡住整份统计
      }
    }
    return { requests, shape };
  } finally {
    db.close();
  }
}

function inWindow(time, since, until) {
  return (!since || time >= since) && (!until || time < until);
}

function parseArgs(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--since' || arg === '--until') {
      const value = Date.parse(argv[++index] ?? '');
      if (Number.isNaN(value)) throw new Error(`${arg} needs a date`);
      options[arg.slice(2)] = value;
    } else if (arg === '--root') options.root = argv[++index];
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function logTime(name) {
  const stamp = LOG_TIME.exec(name)?.[1];
  if (!stamp) return 0;
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`;
  return Date.parse(iso);
}

export function report(options) {
  const root = options.root ?? path.join(os.homedir(), '.gemini', 'antigravity-cli');
  const monitor = newMonitorTally();
  const logDir = path.join(root, 'log');
  for (const name of readdirSync(logDir)) {
    if (!name.startsWith('acp-server-') || !inWindow(logTime(name), options.since, options.until))
      continue;
    tallyMonitorLog(readFileSync(path.join(logDir, name), 'utf8'), monitor);
  }
  const prechecks = Object.values(monitor.reasons).reduce((sum, count) => sum + count, 0);
  const enso = Object.entries(monitor.reasons).filter(([reason]) => isEnsoReason(reason));

  const convDir = path.join(root, 'conversations');
  const byModel = {};
  const firsts = [];
  // 只看挂了 Enso 工具的会话：老版本或探测会话没有 append / mcp_enso_*，混进来中位数会失真
  const shapes = [];
  for (const name of readdirSync(convDir)) {
    if (!name.endsWith('.db')) continue;
    const file = path.join(convDir, name);
    if (!inWindow(statSync(file).mtimeMs, options.since, options.until)) continue;
    const { requests, shape } = conversationStats(file);
    if (requests.length === 0) continue;
    firsts.push(requests[0]);
    if (shape?.ensoToolCount) shapes.push(shape);
    for (const usage of requests) {
      const model = usage.model || '?';
      byModel[model] ??= { requests: 0, input: 0, cached: 0, output: 0 };
      const row = byModel[model];
      row.requests += 1;
      row.input += usage.input;
      row.cached += usage.cached;
      row.output += usage.output;
    }
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  };
  return {
    prechecks: {
      total: prechecks,
      skipped: monitor.skipped,
      enso: enso.reduce((sum, [, count]) => sum + count, 0),
      ensoByTool: Object.fromEntries(enso.sort((a, b) => b[1] - a[1])),
      trajectoryChars: Object.values(monitor.trajectoryChars).reduce((sum, n) => sum + n, 0),
    },
    conversations: firsts.length,
    firstRequest: {
      medianUncachedInput: median(firsts.map((usage) => usage.input)),
      withCacheHit: firsts.filter((usage) => usage.cached > 0).length,
      medianEnsoToolBytes: median(shapes.map((shape) => shape.ensoTools)),
      medianAppendBytes: median(shapes.map((shape) => shape.append)),
    },
    byModel,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const result = report(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    const p = result.prechecks;
    console.log(
      `agy 安全预审（sir_flash_lite）${p.total} 次，其中 EnsoCode MCP 工具触发 ${p.enso} 次；放行 ${p.skipped} 次`
    );
    for (const [reason, count] of Object.entries(p.ensoByTool))
      console.log(`  ${count}\t${reason}`);
    const f = result.firstRequest;
    console.log(
      `会话 ${result.conversations} 个；首个请求未命中缓存输入中位数 ${f.medianUncachedInput} token，命中缓存的 ${f.withCacheHit} 个；` +
        `mcp_enso_* 工具声明中位数 ${f.medianEnsoToolBytes} B，append 中位数 ${f.medianAppendBytes} B`
    );
    for (const [model, row] of Object.entries(result.byModel))
      console.log(
        `  ${model}\t请求 ${row.requests}\t未缓存输入 ${row.input}\t缓存输入 ${row.cached}\t输出 ${row.output}`
      );
  }
}
