import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentCallKey,
  claimInterruptedWorkflowRuns,
  WorkflowJournal,
  workflowJournalFile,
} from './workflowJournal';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-wf-journal-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const launch = (runId: string, sessionId = 's1') => ({
  runId,
  sessionId,
  name: 'review',
  description: 'Review things',
  script: 'return 1',
  args: { a: 1 },
  startedAt: 1000,
});

describe('agentCallKey', () => {
  it('同一前缀与同样的派发参数得到同一键；提示、模型、类型、schema 变化或前缀变化都换键；label 不影响', () => {
    const base = agentCallKey('', { prompt: 'p', model: 'm', label: 'x' });
    expect(agentCallKey('', { prompt: 'p', model: 'm', label: 'y' })).toBe(base);
    expect(agentCallKey('', { prompt: 'p2', model: 'm' })).not.toBe(base);
    expect(agentCallKey('', { prompt: 'p', model: 'm2' })).not.toBe(base);
    expect(agentCallKey('', { prompt: 'p', model: 'm', agentType: 'scout' })).not.toBe(base);
    expect(agentCallKey(base, { prompt: 'p', model: 'm' })).not.toBe(base);
    expect(agentCallKey('', { prompt: 'p', schema: { b: 1, a: 2 } })).toBe(
      agentCallKey('', { prompt: 'p', schema: { a: 2, b: 1 } })
    );
  });
});

describe('WorkflowJournal', () => {
  it('记录启动参数与成功结果，重新打开可读回；坏行被跳过', () => {
    const journal = new WorkflowJournal(dir, 'r1');
    journal.launch(launch('r1'));
    journal.recordResult('k1', 'first');
    journal.recordResult('k2', { ok: true });
    writeFileSync(workflowJournalFile(dir, 'r1'), '{oops\n', { flag: 'a' });
    const reopened = new WorkflowJournal(dir, 'r1');
    expect(reopened.readLaunch()).toEqual(launch('r1'));
    expect([...reopened.results()]).toEqual([
      ['k1', 'first'],
      ['k2', { ok: true }],
    ]);
    expect(reopened.isSettled()).toBe(false);
    reopened.settle('failed');
    expect(new WorkflowJournal(dir, 'r1').isSettled()).toBe(true);
  });

  it('被显式停止的运行删掉日志，完成与失败的保留以便续跑', () => {
    for (const [runId, status] of [
      ['done', 'completed'],
      ['stopped', 'cancelled'],
      ['broken', 'failed'],
    ] as const) {
      const journal = new WorkflowJournal(dir, runId);
      journal.launch(launch(runId));
      journal.settle(status);
    }
    expect(readdirSync(dir).sort()).toEqual(
      ['broken', 'done'].map((id) => path.basename(workflowJournalFile(dir, id)))
    );
  });

  it('非法 runId 不能逃出日志目录', () => {
    expect(() => new WorkflowJournal(dir, '../evil')).toThrow();
  });
});

describe('claimInterruptedWorkflowRuns', () => {
  it('只认领本会话、未收尾、且不在本进程运行中的运行；认领一次后不再出现；过期日志清理', () => {
    for (const [runId, sessionId] of [
      ['mine', 's1'],
      ['live', 's1'],
      ['other', 's2'],
    ]) {
      new WorkflowJournal(dir, runId).launch(launch(runId, sessionId));
    }
    const settled = new WorkflowJournal(dir, 'settled');
    settled.launch(launch('settled'));
    settled.settle('failed');
    const stale = new WorkflowJournal(dir, 'stale');
    stale.launch(launch('stale'));
    const old = new Date(Date.now() - 30 * 24 * 3600_000);
    utimesSync(workflowJournalFile(dir, 'stale'), old, old);

    const claimed = claimInterruptedWorkflowRuns(dir, 's1', new Set(['live']));
    expect(claimed.map((run) => run.runId)).toEqual(['mine']);
    expect(claimInterruptedWorkflowRuns(dir, 's1', new Set(['live']))).toEqual([]);
    expect(new WorkflowJournal(dir, 'mine').readLaunch()?.name).toBe('review');
    expect(readdirSync(dir)).not.toContain(path.basename(workflowJournalFile(dir, 'stale')));
  });

  it('目录不存在时返回空', () => {
    expect(claimInterruptedWorkflowRuns(path.join(dir, 'nope'), 's1', new Set())).toEqual([]);
  });
});
