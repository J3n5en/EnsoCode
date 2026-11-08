import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignAnnotationsStore } from './designAnnotations';

const sampleElement = {
  tagName: 'BUTTON',
  id: 'save-btn',
  uniqueId: 'cursor-el-1',
  className: 'btn',
  innerText: 'Save',
  path: 'form > button#save-btn',
  attributes: [],
  rect: { top: 10, left: 20, width: 80, height: 32 },
  styles: {
    color: '#fff',
    backgroundColor: '#000',
    fontSize: '14px',
    fontFamily: 'sans-serif',
    display: 'inline-block',
    position: 'static',
  },
};

describe('useDesignAnnotationsStore', () => {
  beforeEach(() => {
    useDesignAnnotationsStore.getState().resetForTests();
  });

  it('tracks familiarity progression (never -> few -> many) and sendImmediately preference', () => {
    const store = useDesignAnnotationsStore.getState();
    expect(store.familiarity()).toBe('never');
    expect(store.annotateSendImmediately).toBe(true);

    store.markEntered();
    expect(useDesignAnnotationsStore.getState().familiarity()).toBe('few');

    for (let i = 0; i < 6; i++) {
      useDesignAnnotationsStore.getState().addAnnotation('conv-1', {
        id: `ann-${i}`,
        kind: 'element',
        comment: `edit ${i}`,
        browserId: 'tab-1',
        pageKey: 'http://localhost:3000/',
        images: [],
        elements: [sampleElement],
      });
    }
    expect(useDesignAnnotationsStore.getState().annotateUseCount).toBe(6);
    expect(useDesignAnnotationsStore.getState().familiarity()).toBe('many');

    useDesignAnnotationsStore.getState().setSendImmediately(false);
    expect(useDesignAnnotationsStore.getState().annotateSendImmediately).toBe(false);
  });

  it('manages per-agent annotation queues, optimistic remove, and restore on failure', () => {
    const store = useDesignAnnotationsStore.getState();
    store.setBrowserUrl('tab-1', 'http://localhost:3000/page#hash');
    expect(useDesignAnnotationsStore.getState().pageKeyOf('tab-1')).toBe(
      'http://localhost:3000/page'
    );

    store.addAnnotation('conv-1', {
      id: 'a1',
      kind: 'element',
      comment: 'first',
      browserId: 'tab-1',
      pageKey: 'http://localhost:3000/page',
      images: [],
      elements: [sampleElement],
    });
    store.addAnnotation('conv-1', {
      id: 'a2',
      kind: 'element',
      comment: 'second',
      browserId: 'tab-1',
      pageKey: 'http://localhost:3000/page',
      images: [],
      elements: [sampleElement],
    });

    const list = useDesignAnnotationsStore.getState().annotationsFor('conv-1');
    expect(list.map((i) => [i.id, i.number])).toEqual([
      ['a1', 1],
      ['a2', 2],
    ]);

    useDesignAnnotationsStore.getState().removeAnnotations('conv-1', ['a1']);
    expect(
      useDesignAnnotationsStore
        .getState()
        .annotationsFor('conv-1')
        .map((i) => i.id)
    ).toEqual(['a2']);

    useDesignAnnotationsStore.getState().restoreAnnotations('conv-1', [list[0]!]);
    expect(
      useDesignAnnotationsStore
        .getState()
        .annotationsFor('conv-1')
        .map((i) => [i.id, i.number])
    ).toEqual([
      ['a1', 1],
      ['a2', 2],
    ]);
  });

  it('caches annotationsFor(agent, browserId) snapshot reference to satisfy React 19 useSyncExternalStore', () => {
    const store = useDesignAnnotationsStore.getState();
    store.addAnnotation('conv-1', {
      id: 'ann-1',
      kind: 'element',
      comment: 'Fix alignment',
      browserId: 'tab-1',
      pageKey: 'http://localhost:3000/',
      images: [],
      elements: [
        {
          tagName: 'DIV',
          id: 'box',
          uniqueId: 'u-box',
          className: '',
          innerText: 'Box',
          path: 'div#box',
          attributes: [],
          rect: { top: 0, left: 0, width: 50, height: 50 },
          styles: {
            color: '',
            backgroundColor: '',
            fontSize: '',
            fontFamily: '',
            display: 'block',
            position: 'static',
          },
        },
      ],
    });

    const s = useDesignAnnotationsStore.getState();
    const snap1 = s.annotationsFor('conv-1', 'tab-1');
    const snap2 = s.annotationsFor('conv-1', 'tab-1');
    expect(snap1).toBe(snap2);
    expect(snap1).toHaveLength(1);
  });
});
