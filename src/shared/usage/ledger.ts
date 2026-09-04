import type { ActivitySpan, SessionActivity } from './aggregate';
import type { UsageRecord } from './types';

export interface UsageSessionSlice {
  sessionId: string;
  records: UsageRecord[];
  spans: ActivitySpan[];
}

export interface MergedUsage {
  records: UsageRecord[];
  activity: SessionActivity[];
}

function covers(span: ActivitySpan, ts: number): boolean {
  return ts >= span.start && ts <= span.end;
}

/**
 * live jsonl 覆盖同 id 的账本行。fork 共用的 jsonl entry id 只留一份。
 * activity：某 session 只保留「该 session 仍拥有的 record」所落在的 span，避免 fork 前缀把活跃时长算两遍。
 */
export function mergeUsageSources(
  live: readonly UsageSessionSlice[],
  ledger: readonly UsageSessionSlice[]
): MergedUsage {
  const byId = new Map<string, UsageRecord>();
  const fromLive = new Set<string>();
  for (const session of ledger) {
    for (const record of session.records) {
      if (record.id && !byId.has(record.id)) byId.set(record.id, record);
    }
  }
  // 同一 id 只认第一次 live（fork 副本不再覆盖），并可覆盖账本
  for (const session of live) {
    for (const record of session.records) {
      if (!record.id || fromLive.has(record.id)) continue;
      byId.set(record.id, record);
      fromLive.add(record.id);
    }
  }
  const records = [...byId.values()];
  const keptTs = new Map<string, number[]>();
  for (const record of records) {
    const list = keptTs.get(record.sessionId);
    if (list) list.push(record.ts);
    else keptTs.set(record.sessionId, [record.ts]);
  }

  const spanBySession = new Map<string, ActivitySpan[]>();
  for (const session of ledger) spanBySession.set(session.sessionId, session.spans);
  for (const session of live) spanBySession.set(session.sessionId, session.spans);

  const activity: SessionActivity[] = [];
  for (const [sessionId, spans] of spanBySession) {
    const stamps = keptTs.get(sessionId);
    if (!stamps) continue;
    const clipped = spans.filter((span) => stamps.some((ts) => covers(span, ts)));
    if (clipped.length > 0) activity.push({ sessionId, spans: clipped });
  }
  return { records, activity };
}
