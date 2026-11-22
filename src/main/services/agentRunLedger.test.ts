import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_RUN_LEDGER_LIMIT,
  type AgentRunLedgerEntry,
  fileAgentRunLedger,
  parseAgentRunLedger,
} from './agentRunLedger';

const entry = (runId: string, over: Partial<AgentRunLedgerEntry> = {}): AgentRunLedgerEntry => ({
  runId,
  agentId: `agent-${runId}`,
  ownerId: 'chat-1',
  projectId: 'project-1',
  ownerKind: 'chatSession',
  mode: 'task',
  status: 'running',
  createdAt: 1,
  ...over,
});

describe('parseAgentRunLedger', () => {
  it('丢弃坏条目，保留合法条目', () => {
    expect(
      parseAgentRunLedger({
        runs: [
          entry('ok', { finishedAt: 5, status: 'succeeded' }),
          { ...entry('bad-status'), status: 'weird' },
          { ...entry('bad-mode'), mode: 'x' },
          { ...entry(''), runId: '' },
          null,
          'junk',
        ],
      })
    ).toEqual([entry('ok', { finishedAt: 5, status: 'succeeded' })]);
  });

  it('保留标题与父会话是否已知情；类型不对的可选字段丢掉', () => {
    expect(
      parseAgentRunLedger({
        runs: [
          { ...entry('a'), title: '核实疑似 bug', notified: false },
          { ...entry('b'), title: 42, notified: 'yes' },
        ],
      })
    ).toEqual([entry('a', { title: '核实疑似 bug', notified: false }), entry('b')]);
  });

  it('不是台账形状时返回空，并只留最近的条目', () => {
    expect(parseAgentRunLedger(null)).toEqual([]);
    expect(parseAgentRunLedger([entry('a')])).toEqual([]);
    const many = Array.from({ length: AGENT_RUN_LEDGER_LIMIT + 3 }, (_, i) => entry(`r${i}`));
    const parsed = parseAgentRunLedger({ runs: many });
    expect(parsed).toHaveLength(AGENT_RUN_LEDGER_LIMIT);
    expect(parsed[0].runId).toBe('r3');
  });
});

describe('fileAgentRunLedger', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('写入后可读回；文件缺失或损坏时读到空表', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'agent-run-ledger-'));
    const file = path.join(dir, 'nested', 'subagent-runs.json');
    const ledger = fileAgentRunLedger(file);
    expect(ledger.load()).toEqual([]);
    ledger.save([entry('a'), entry('b', { status: 'interrupted', finishedAt: 3 })]);
    expect(ledger.load()).toEqual([
      entry('a'),
      entry('b', { status: 'interrupted', finishedAt: 3 }),
    ]);
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
    writeFileSync(file, '{not json');
    expect(ledger.load()).toEqual([]);
  });
});
