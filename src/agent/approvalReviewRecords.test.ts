import { describe, expect, it } from 'vitest';
import { approvalReviewResultExtension, rememberApprovalReview } from './approvalReviewRecords';

type Handler = (event: Record<string, unknown>) => unknown;

function toolResultHandler(): Handler {
  let handler: Handler | undefined;
  const pi = {
    on: (name: string, fn: Handler) => {
      if (name === 'tool_result') handler = fn;
    },
  };
  const extension = approvalReviewResultExtension;
  if (typeof extension === 'function') throw new Error('expected named extension');
  extension.factory(pi as never);
  if (!handler) throw new Error('missing handler');
  return handler;
}

describe('approvalReviewResultExtension', () => {
  const record = { verdict: 'deny' as const, model: 'jev', allow: 0.6, ask: 0.1, block: 0.3 };

  it('把托管判定并进该调用的工具结果 details（含失败结果），只用一次', () => {
    const handler = toolResultHandler();
    rememberApprovalReview('call-1', record);
    expect(handler({ toolCallId: 'call-1', isError: true, details: { kept: 1 } })).toEqual({
      details: { kept: 1, approvalReview: record },
    });
    expect(handler({ toolCallId: 'call-1', details: {} })).toBeUndefined();
  });

  it('没有判定的调用不改结果；非对象 details 不展开', () => {
    const handler = toolResultHandler();
    expect(handler({ toolCallId: 'other', details: {} })).toBeUndefined();
    rememberApprovalReview('call-2', record);
    expect(handler({ toolCallId: 'call-2', details: undefined })).toEqual({
      details: { approvalReview: record },
    });
  });
});
