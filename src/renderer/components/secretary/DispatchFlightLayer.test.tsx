import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchFlightTiming } from '@/lib/dispatchFlight';
import { _resetDispatchFlights, useDispatchFlightStore } from '@/stores/dispatchFlight';
import { DispatchFlightLayer } from './DispatchFlightLayer';

const deps = vi.hoisted(() => ({
  conversations: {} as Record<string, { projectId: string }>,
  projects: [] as { id: string; kind?: string }[],
  secretaries: [] as { id: string; projectId: string | null }[],
}));

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: {
    getState: () => ({ conversations: deps.conversations }),
  },
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: {
    getState: () => ({ projects: deps.projects }),
  },
}));

vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: {
    getState: () => ({ secretaries: deps.secretaries }),
  },
}));

interface Recorded {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  finish: () => void;
  cancel: () => void;
}

const recorded: Recorded[] = [];
const timing = { ...dispatchFlightTiming };

function box(node: HTMLElement, left: number, top: number, width: number, height: number) {
  node.getBoundingClientRect = () =>
    ({
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON() {
        return {};
      },
    }) as DOMRect;
}

function installMatchMedia(reduce: boolean) {
  const matchMedia = (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
    onchange: null,
  });
  window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
}

function stage(options: { row?: boolean; badge?: boolean } = {}) {
  const sidebar = document.createElement('div');
  sidebar.setAttribute('data-enso', 'sidebar');
  box(sidebar, 0, 0, 240, 400);
  const section = document.createElement('div');
  section.setAttribute('data-enso', 'secretary-section');
  const avatar = document.createElement('div');
  avatar.setAttribute('data-enso', 'secretary-avatar');
  box(avatar, 10, 10, 28, 28);
  section.appendChild(avatar);
  sidebar.appendChild(section);
  const active = document.createElement('div');
  active.setAttribute('data-slot', 'active-section');
  if (options.row !== false) {
    const row = document.createElement('div');
    row.setAttribute('data-enso', 'session-row');
    row.setAttribute('data-conversation', 'room-1');
    box(row, 8, 80, 220, 32);
    if (options.badge !== false) {
      const badge = document.createElement('div');
      badge.setAttribute('data-enso', 'secretary-origin');
      box(badge, 190, 88, 14, 14);
      row.appendChild(badge);
    }
    active.appendChild(row);
  }
  sidebar.appendChild(active);
  const timeline = document.createElement('div');
  timeline.setAttribute('data-enso', 'timeline');
  const nav = document.createElement('div');
  nav.setAttribute('data-nav-key', '2-0');
  const card = document.createElement('div');
  card.setAttribute('data-enso', 'tool-card');
  box(card, 300, 160, 80, 40);
  nav.appendChild(card);
  timeline.appendChild(nav);
  document.body.append(sidebar, timeline);
}

async function pump() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function enqueue() {
  useDispatchFlightStore.getState().enqueueDispatchFlight({
    toolName: 'session_send',
    navKey: '2-0',
    targetId: 'room-1',
    projectId: 'sec',
    toolCallId: 'call-1',
  });
}

describe('DispatchFlightLayer', () => {
  let root: Root;

  beforeEach(() => {
    const dom = parseHTML('<html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('CSS', {
      escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`),
    });
    _resetDispatchFlights();
    recorded.length = 0;
    deps.conversations = { 'room-1': { projectId: 'local' } };
    deps.projects = [
      { id: 'sec', kind: 'secretary' },
      { id: 'local', kind: 'local' },
    ];
    deps.secretaries = [];
    dispatchFlightTiming.intervalMs = timing.intervalMs;
    dispatchFlightTiming.timeoutMs = timing.timeoutMs;
    installMatchMedia(false);
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    document.body.innerHTML = '';
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    root = createRoot(mount);
    dom.window.Element.prototype.animate = function animate(
      keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      options?: number | KeyframeAnimationOptions
    ) {
      let finish = () => {};
      const finished = new Promise<Animation>((resolve) => {
        finish = () => resolve(this as unknown as Animation);
      });
      const entry: Recorded = {
        keyframes: Array.isArray(keyframes) ? keyframes : [],
        options: typeof options === 'object' && options ? options : {},
        finish,
        cancel() {},
      };
      recorded.push(entry);
      return { finished, cancel: entry.cancel } as unknown as Animation;
    };
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('克隆头像飞完后消失，并把飞行从队列里拿走', async () => {
    stage();
    await act(async () => {
      root.render(createElement(DispatchFlightLayer));
    });
    await act(async () => {
      enqueue();
    });
    await pump();
    const clone = document.querySelector('[data-enso="secretary-flight"]');
    expect(clone).not.toBeNull();
    expect(recorded).toHaveLength(1);
    const offsets = recorded[0]?.keyframes.map((frame) => Number(frame.offset)) ?? [];
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(1);
    for (let index = 1; index < offsets.length; index += 1) {
      expect(offsets[index]).toBeGreaterThan(offsets[index - 1] ?? 0);
    }
    expect(recorded[0]?.options).toMatchObject({
      duration: 1050,
      easing: 'cubic-bezier(0.45, 0, 0.2, 1)',
      fill: 'forwards',
    });
    await act(async () => {
      recorded[0]?.finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-enso="secretary-flight"]')).toBeNull();
    expect(useDispatchFlightStore.getState().flights).toEqual([]);
  });

  it('系统要求减少动效时不播', async () => {
    installMatchMedia(true);
    stage();
    await act(async () => {
      root.render(createElement(DispatchFlightLayer));
    });
    await act(async () => {
      enqueue();
    });
    await pump();
    expect(recorded).toHaveLength(0);
    expect(document.querySelector('[data-enso="secretary-flight"]')).toBeNull();
    expect(useDispatchFlightStore.getState().flights).toEqual([]);
  });

  it('目标行一直不出现就放弃', async () => {
    vi.useFakeTimers();
    dispatchFlightTiming.intervalMs = 50;
    dispatchFlightTiming.timeoutMs = 200;
    stage({ row: false });
    await act(async () => {
      root.render(createElement(DispatchFlightLayer));
    });
    await act(async () => {
      enqueue();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(recorded).toHaveLength(0);
    expect(document.querySelector('[data-enso="secretary-flight"]')).toBeNull();
    expect(useDispatchFlightStore.getState().flights).toEqual([]);
  });

  it('派给另一个秘书时不播', async () => {
    deps.conversations = { 'room-1': { projectId: 'sec' } };
    stage();
    await act(async () => {
      root.render(createElement(DispatchFlightLayer));
    });
    await act(async () => {
      enqueue();
    });
    await pump();
    expect(recorded).toHaveLength(0);
    expect(useDispatchFlightStore.getState().flights).toEqual([]);
  });

  it('目标行滚不进视野时只飞到卡片再淡出', async () => {
    stage();
    const row = document.querySelector('[data-conversation="room-1"]');
    if (row instanceof HTMLElement) box(row, 8, 900, 220, 32);
    await act(async () => {
      root.render(createElement(DispatchFlightLayer));
    });
    await act(async () => {
      enqueue();
    });
    await pump();
    expect(recorded[0]?.options.duration).toBeLessThan(1050);
    expect(recorded[0]?.keyframes.at(-1)?.opacity).toBe(0);
    await act(async () => {
      recorded[0]?.finish();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-enso="secretary-flight"]')).toBeNull();
  });
});
