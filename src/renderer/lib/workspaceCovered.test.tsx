import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAppViewStore } from '@/stores/appView';
import {
  acquireOverlayGuard,
  overlayGuardActive,
  releaseOverlayGuard,
  resetOverlayGuard,
  setOverlayGuardSink,
} from './overlayGuard';
import { escapeBlockedBeforeHandlers } from './settingsEscape';
import { useWorkspaceCovered } from './workspaceCovered';

let container: HTMLElement;
let root: Root;
let calls: boolean[];

function Harness({ covered }: { covered: boolean }) {
  useWorkspaceCovered(covered);
  return null;
}

const render = (covered: boolean) => act(async () => root.render(<Harness covered={covered} />));

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  calls = [];
  setOverlayGuardSink((active) => calls.push(active));
  useAppViewStore.setState({ workbenchCovered: false });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  resetOverlayGuard();
  vi.unstubAllGlobals();
});

it('设置页盖住工作区时立刻让原生 guest 沉下去，关闭后复位', async () => {
  await render(true);
  expect(calls).toEqual([true]);
  expect(useAppViewStore.getState().workbenchCovered).toBe(true);

  await render(false);
  expect(calls).toEqual([true, false]);
  expect(useAppViewStore.getState().workbenchCovered).toBe(false);
});

it('工作区没被盖住时不动 guest', async () => {
  await render(false);
  expect(calls).toEqual([]);
});

it('设置页自己的遮盖不算模态浮层：Esc 仍能退出设置', async () => {
  await render(true);
  expect(calls).toEqual([true]);
  expect(overlayGuardActive()).toBe(false);
  expect(escapeBlockedBeforeHandlers(document)).toBe(false);
});

it('设置页之上开真弹窗：Esc 先归弹窗，关掉后 guest 不闪回且 Esc 恢复', async () => {
  await render(true);
  acquireOverlayGuard();
  expect(escapeBlockedBeforeHandlers(document)).toBe(true);
  releaseOverlayGuard();
  expect(calls).toEqual([true]);
  expect(escapeBlockedBeforeHandlers(document)).toBe(false);

  await render(false);
  expect(calls).toEqual([true, false]);
});
