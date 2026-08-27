/** 把 exec / interaction 结果编成 Cursor Connect 帧，经 pi-cursor 的 write 回写。 */

import type { CursorExecDispatchResult } from './execBridge';
import type { CursorInteractionDecision } from './interactionQuery';

const EXEC_RESULT_FIELD: Record<string, number> = {
  readArgs: 7,
  lsArgs: 8,
  grepArgs: 5,
  writeArgs: 3,
  shellArgs: 2,
  shellStreamArgs: 14,
};

export function encodeExecWriteBack(
  execCase: string,
  execMsg: { id?: number; execId?: string },
  dispatched: CursorExecDispatchResult
): Uint8Array {
  const resultField = EXEC_RESULT_FIELD[execCase] ?? EXEC_RESULT_FIELD.readArgs;
  const result = encodeTypedResult(execCase, dispatched);
  const execClient = concat([
    encVarint(1, execMsg.id ?? 0),
    execMsg.execId ? encString(15, execMsg.execId) : new Uint8Array(),
    encBytes(resultField, result),
  ]);
  return connectFrame(encBytes(2, execClient));
}

export function encodeInteractionWriteBack(
  queryId: number,
  decision: CursorInteractionDecision
): Uint8Array | null {
  if (decision.response === 'unanswered') return null;
  const resultField = interactionResultField(decision.queryCase);
  if (resultField === null) return null;
  const inner = encodeInteractionInner(decision.queryCase, decision.response);
  if (inner.length === 0) return null;
  const interaction = concat([encVarint(1, queryId), encBytes(resultField, inner)]);
  return connectFrame(encBytes(6, interaction));
}

function encodeInteractionInner(queryCase: string, response: 'approved' | 'rejected'): Uint8Array {
  const reason = 'not implemented by this client';
  switch (queryCase) {
    case 'askQuestionInteractionQuery':
      // AskQuestionInteractionResponse.result = AskQuestionResult.rejected
      return encBytes(1, encBytes(3, encString(1, reason)));
    case 'createPlanRequestQuery':
      // CreatePlanRequestResponse.result = CreatePlanResult.error
      return encBytes(1, encBytes(2, encString(1, reason)));
    case 'switchModeRequestQuery':
      return encBytes(2, encString(1, reason));
    case 'webSearchRequestQuery':
    case 'exaSearchRequestQuery':
    case 'exaFetchRequestQuery':
    case 'webFetchRequestQuery':
      return response === 'approved'
        ? encBytes(1, new Uint8Array())
        : encBytes(2, encString(1, reason));
    default:
      return new Uint8Array();
  }
}

function encodeTypedResult(execCase: string, dispatched: CursorExecDispatchResult): Uint8Array {
  const path = typeof dispatched.args.path === 'string' ? dispatched.args.path : '';
  const command = typeof dispatched.args.command === 'string' ? dispatched.args.command : '';
  const cwd = typeof dispatched.args.cwd === 'string' ? dispatched.args.cwd : '';

  if (execCase === 'grepArgs') {
    if (dispatched.isError) return encBytes(2, encString(1, dispatched.resultText));
    const match = concat([
      encString(1, path || '.'),
      encBytes(2, concat([encVarint(1, 1), encString(2, dispatched.resultText)])),
    ]);
    const content = concat([encBytes(1, match), encVarint(2, 1), encVarint(3, 1)]);
    const union = encBytes(3, content);
    const entry = concat([encString(1, path || '.'), encBytes(2, union)]);
    const pattern = typeof dispatched.args.pattern === 'string' ? dispatched.args.pattern : '';
    return encBytes(
      1,
      concat([
        encString(1, pattern),
        encString(2, path || '.'),
        encString(3, 'content'),
        encBytes(4, entry),
      ])
    );
  }

  if (execCase === 'writeArgs') {
    if (dispatched.isError) {
      return encBytes(5, concat([encString(1, path), encString(2, dispatched.resultText)]));
    }
    const lines = dispatched.resultText ? dispatched.resultText.split('\n').length : 0;
    return encBytes(
      1,
      concat([
        encString(1, path),
        encVarint(2, lines),
        encVarint(3, Buffer.byteLength((dispatched.args.content as string) ?? '', 'utf8')),
      ])
    );
  }

  if (execCase === 'shellArgs' || execCase === 'shellStreamArgs') {
    if (dispatched.isError) {
      const failure = concat([
        encString(1, command),
        encString(2, cwd),
        encVarint(3, 1),
        encString(4, ''),
        encString(5, ''),
        encString(6, dispatched.resultText),
        encVarint(7, 0),
      ]);
      return execCase === 'shellStreamArgs'
        ? encBytes(
            2,
            concat([encString(1, command), encString(2, cwd), encString(3, dispatched.resultText)])
          )
        : encBytes(2, failure);
    }
    const success = concat([
      encString(1, command),
      encString(2, cwd),
      encVarint(3, 0),
      encString(4, ''),
      encString(5, dispatched.resultText),
      encString(6, ''),
      encVarint(7, 0),
    ]);
    return encBytes(1, success);
  }

  // read / ls
  if (dispatched.isError) {
    return encBytes(2, concat([encString(1, path), encString(2, dispatched.resultText)]));
  }
  const lines = dispatched.resultText ? dispatched.resultText.split('\n').length : 0;
  const success = concat([
    encString(1, path),
    encString(2, dispatched.resultText),
    encVarint(3, lines),
    encVarint(4, Buffer.byteLength(dispatched.resultText, 'utf8')),
  ]);
  return encBytes(1, success);
}

function interactionResultField(queryCase: string): number | null {
  switch (queryCase) {
    case 'webSearchRequestQuery':
      return 2;
    case 'askQuestionInteractionQuery':
      return 3;
    case 'switchModeRequestQuery':
      return 4;
    case 'exaSearchRequestQuery':
      return 5;
    case 'exaFetchRequestQuery':
      return 6;
    case 'createPlanRequestQuery':
      return 7;
    case 'webFetchRequestQuery':
      return 9;
    default:
      return null;
  }
}

function connectFrame(payload: Uint8Array): Uint8Array {
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const filtered = parts.filter((part) => part.length > 0);
  return Buffer.concat(filtered);
}

function encVarint(field: number, value: number): Uint8Array {
  return concat([tag(field, 0), uvarint(value >>> 0)]);
}

function encString(field: number, value: string): Uint8Array {
  return encBytes(field, Buffer.from(value, 'utf8'));
}

function encBytes(field: number, value: Uint8Array): Uint8Array {
  return concat([tag(field, 2), uvarint(value.length), value]);
}

function tag(field: number, wire: number): Uint8Array {
  return uvarint((field << 3) | wire);
}

function uvarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let n = value >>> 0;
  while (n >= 128) {
    bytes.push((n & 127) | 128);
    n >>>= 7;
  }
  bytes.push(n);
  return Uint8Array.from(bytes);
}
