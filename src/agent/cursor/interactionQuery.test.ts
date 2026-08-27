import { describe, expect, it } from 'vitest';
import { handleCursorInteractionQuery } from './interactionQuery';
import { handlePiCursorInteraction } from './sessionBridge';
import { encodeInteractionWriteBack } from './writeBack';

describe('handleCursorInteractionQuery', () => {
  it('宿主搜索/抓取门作答，避免 idle watchdog 掐断', () => {
    for (const queryCase of [
      'webSearchRequestQuery',
      'exaSearchRequestQuery',
      'exaFetchRequestQuery',
      'webFetchRequestQuery',
    ]) {
      const decision = handleCursorInteractionQuery({ id: 1, queryCase });
      expect(decision.handled).toBe(true);
      expect(decision.response).not.toBe('unanswered');
    }
  });

  it('需要完整交互 UI 的帧拒绝，不让流停住', () => {
    for (const queryCase of [
      'askQuestionInteractionQuery',
      'switchModeRequestQuery',
      'createPlanRequestQuery',
    ]) {
      const decision = handleCursorInteractionQuery({ queryCase });
      expect(decision.handled).toBe(true);
      expect(decision.action).toBe('reject');
      expect(decision.response).toBe('rejected');
    }
  });

  it('无名 interaction_query 不写回，让出原 hi 的 unknown-field 拒绝', () => {
    const writes: Uint8Array[] = [];
    const result = handlePiCursorInteraction({ id: 9 }, (bytes) => writes.push(bytes));
    expect(result).toBe(false);
    expect(writes).toEqual([]);
  });

  it('askQuestion 回写嵌套 rejected oneof，不是顶层 string', () => {
    const writes: Uint8Array[] = [];
    const result = handlePiCursorInteraction(
      { id: 3, query: { case: 'askQuestionInteractionQuery' } },
      (bytes) => writes.push(bytes)
    );
    expect(result).not.toBe(false);
    expect(writes).toHaveLength(1);
    const payload = connectPayload(writes[0]!);
    const client = readProto(payload);
    const interaction = readProto(bytesOf(client, 6));
    expect(varintOf(interaction, 1)).toBe(3);
    const ask = readProto(bytesOf(interaction, 3));
    const askResult = readProto(bytesOf(ask, 1));
    const rejected = readProto(bytesOf(askResult, 3));
    expect(textOf(rejected, 1).length).toBeGreaterThan(0);
  });

  it('createPlan 回写嵌套 error oneof', () => {
    const frame = encodeInteractionWriteBack(7, {
      handled: true,
      action: 'reject',
      response: 'rejected',
      queryCase: 'createPlanRequestQuery',
    });
    expect(frame).toBeTruthy();
    const client = readProto(connectPayload(frame!));
    const interaction = readProto(bytesOf(client, 6));
    expect(varintOf(interaction, 1)).toBe(7);
    const plan = readProto(bytesOf(interaction, 7));
    const planResult = readProto(bytesOf(plan, 1));
    const error = readProto(bytesOf(planResult, 2));
    expect(textOf(error, 1).length).toBeGreaterThan(0);
  });
});

function connectPayload(frame: Uint8Array): Uint8Array {
  const length = (frame[1]! << 24) | (frame[2]! << 16) | (frame[3]! << 8) | frame[4]!;
  return frame.subarray(5, 5 + length);
}

type ProtoField = { varint?: number; bytes?: Uint8Array };

function readProto(buf: Uint8Array): Map<number, ProtoField> {
  const out = new Map<number, ProtoField>();
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (offset < buf.length) {
      const byte = buf[offset++]!;
      value |= (byte & 127) << shift;
      if ((byte & 128) === 0) return value >>> 0;
      shift += 7;
    }
    return value >>> 0;
  };
  while (offset < buf.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      out.set(field, { varint: readVarint() });
    } else if (wire === 2) {
      const length = readVarint();
      const slice = buf.subarray(offset, offset + length);
      offset += length;
      out.set(field, { bytes: slice });
    } else {
      break;
    }
  }
  return out;
}

function bytesOf(fields: Map<number, ProtoField>, field: number): Uint8Array {
  const value = fields.get(field)?.bytes;
  if (!value) throw new Error(`missing bytes field ${field}`);
  return value;
}

function varintOf(fields: Map<number, ProtoField>, field: number): number {
  return fields.get(field)?.varint ?? -1;
}

function textOf(fields: Map<number, ProtoField>, field: number): string {
  return new TextDecoder().decode(bytesOf(fields, field));
}
