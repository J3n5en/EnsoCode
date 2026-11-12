import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindFrameChrome,
  type FrameChromeBinding,
  parseDeskChrome,
  serializeDeskChrome,
} from './chrome';

describe('desk chrome cache', () => {
  it('round-trips the edge colors used for the next launch', () => {
    const raw = serializeDeskChrome({ top: 'rgb(255, 255, 255)', bottom: 'rgb(9, 9, 16)' });
    expect(parseDeskChrome(raw)).toEqual({ top: 'rgb(255, 255, 255)', bottom: 'rgb(9, 9, 16)' });
  });

  it('ignores anything that is not a plain rgb color', () => {
    for (const raw of [
      null,
      '',
      '{',
      '{"top":"red","bottom":"rgb(1, 2, 3)"}',
      '{"top":"rgb(1, 2, 3); x: url(y)","bottom":"rgb(1, 2, 3)"}',
    ]) {
      expect(parseDeskChrome(raw)).toBeNull();
    }
  });
});

describe('frame chrome binding', () => {
  const root = { nodeName: 'HTML' } as unknown as Node;
  const body = { nodeName: 'BODY' } as unknown as HTMLElement;
  let observe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    observe = vi.fn();
    vi.stubGlobal(
      'MutationObserver',
      class {
        observe = observe;
        disconnect() {}
      }
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('skips a document that has no documentElement yet instead of observing a non-Node', () => {
    expect(bindFrameChrome({ documentElement: null, body: null }, undefined, () => {})).toBeNull();
    expect(observe).not.toHaveBeenCalled();
  });

  it('binds body once it appears, without rebinding the root', () => {
    const first = bindFrameChrome({ documentElement: root, body: null }, undefined, () => {});
    expect(first?.body).toBe(false);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(root, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    const bound = first as FrameChromeBinding;
    expect(bindFrameChrome({ documentElement: root, body }, bound, () => {})).toBe(bound);
    expect(bound.body).toBe(true);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenLastCalledWith(body, { childList: true });

    bindFrameChrome({ documentElement: root, body }, bound, () => {});
    expect(observe).toHaveBeenCalledTimes(2);
  });
});
