import { useEffect, useRef } from 'react';
import { isMobileViewport } from '@/hooks/useViewport';
import {
  buildDispatchFlightKeyframes,
  DISPATCH_FLIGHT_CARD_MS,
  DISPATCH_FLIGHT_EASING,
  DISPATCH_FLIGHT_MS,
  dispatchFlightTiming,
  type FlightPoint,
  isSecretaryProject,
} from '@/lib/dispatchFlight';
import { Z_INDEX } from '@/lib/z-index';
import { type Flight, useDispatchFlightStore } from '@/stores/dispatchFlight';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

const MAX_PLAYING = 2;

interface CancelToken {
  cancelled: boolean;
  cancel: () => void;
}

function createToken(): CancelToken {
  const token: CancelToken = {
    cancelled: false,
    cancel: () => {
      token.cancelled = true;
    },
  };
  return token;
}

function delay(ms: number, token: CancelToken): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const previous = token.cancel;
    token.cancel = () => {
      clearTimeout(timer);
      previous();
      resolve();
    };
  });
}

function motionBlocked(): boolean {
  if (isMobileViewport()) return true;
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function dispatchedToSecretary(targetId: string): boolean {
  const projectId = useSessionsStore.getState().conversations[targetId]?.projectId;
  if (!projectId) return false;
  return isSecretaryProject(useSettingsStore.getState().projects, projectId);
}

function secretaryIdFor(projectId: string): string | undefined {
  return useSecretaryStore.getState().secretaries.find((entry) => entry.projectId === projectId)
    ?.id;
}

function byEnso(name: string): string {
  return `[data-enso="${name}"]`;
}

function secretaryAvatar(projectId: string): HTMLElement | null {
  const id = secretaryIdFor(projectId);
  const expanded = id
    ? document.querySelector(
        `[data-enso="secretary-section"][data-secretary-id="${CSS.escape(id)}"] [data-enso="secretary-avatar"]`
      )
    : (document.querySelector(
        '[data-enso="secretary-section"]:not([data-secretary-id]) [data-enso="secretary-avatar"]'
      ) ?? document.querySelector(byEnso('secretary-avatar')));
  const collapsed = id
    ? document.querySelector(
        `[data-enso="secretary-collapsed"][data-secretary-id="${CSS.escape(id)}"]`
      )
    : document.querySelector(byEnso('secretary-collapsed'));
  const node = expanded ?? collapsed;
  return node instanceof HTMLElement ? node : null;
}

interface FlightNodes {
  card: HTMLElement;
  row: HTMLElement;
  avatar: HTMLElement;
}

function flightNodes(flight: Flight): FlightNodes | null {
  const nav = CSS.escape(flight.navKey);
  const card =
    document.querySelector(
      `[data-enso="timeline"] [data-nav-key="${nav}"] [data-enso="tool-card"]`
    ) ?? document.querySelector(`[data-enso="timeline"] [data-nav-key="${nav}"]`);
  const row = document.querySelector(
    `[data-enso="sidebar"] [data-slot="active-section"] [data-conversation="${CSS.escape(flight.targetId)}"]`
  );
  const avatar = secretaryAvatar(flight.projectId);
  if (!(card instanceof HTMLElement) || !(row instanceof HTMLElement) || !avatar) return null;
  return { card, row, avatar };
}

async function waitForNodes(flight: Flight, token: CancelToken): Promise<FlightNodes | null> {
  const deadline = Date.now() + dispatchFlightTiming.timeoutMs;
  while (!token.cancelled) {
    const nodes = flightNodes(flight);
    if (nodes) return nodes;
    if (Date.now() >= deadline) return null;
    await delay(dispatchFlightTiming.intervalMs, token);
  }
  return null;
}

function centerOf(rect: DOMRect): FlightPoint {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function rowInSidebar(row: HTMLElement): boolean {
  const frame =
    row.closest('[data-enso="sidebar"]') ?? document.querySelector('[data-enso="sidebar"]');
  if (!(frame instanceof HTMLElement)) return false;
  const rowRect = row.getBoundingClientRect();
  const box = frame.getBoundingClientRect();
  return rowRect.top >= box.top && rowRect.bottom <= box.bottom;
}

function mountClone(avatar: HTMLElement): HTMLElement {
  const rect = avatar.getBoundingClientRect();
  const clone = avatar.cloneNode(true);
  if (!(clone instanceof HTMLElement)) {
    const fallback = document.createElement('div');
    document.body.appendChild(fallback);
    return fallback;
  }
  clone.setAttribute('data-enso', 'secretary-flight');
  clone.style.position = 'fixed';
  clone.style.left = `${rect.left}px`;
  clone.style.top = `${rect.top}px`;
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.style.margin = '0';
  clone.style.pointerEvents = 'none';
  clone.style.transformOrigin = 'center center';
  clone.style.zIndex = String(Z_INDEX.DEVTOOLS_OVERLAY);
  document.body.appendChild(clone);
  return clone;
}

function playClone(clone: HTMLElement, nodes: FlightNodes, token: CancelToken): Promise<void> {
  const avatarRect = nodes.avatar.getBoundingClientRect();
  const cardRect = nodes.card.getBoundingClientRect();
  let rowVisible = rowInSidebar(nodes.row);
  if (!rowVisible && typeof nodes.row.scrollIntoView === 'function') {
    nodes.row.scrollIntoView({ block: 'nearest' });
    rowVisible = rowInSidebar(nodes.row);
  }
  const rowRect = nodes.row.getBoundingClientRect();
  const p0 = centerOf(avatarRect);
  const p1 = centerOf(cardRect);
  const p2 = { x: rowRect.left + 2, y: rowRect.top + rowRect.height / 2 };
  const badge = nodes.row.querySelector('[data-enso="secretary-origin"]');
  const badgeRect = badge instanceof HTMLElement ? badge.getBoundingClientRect() : null;
  const p3 = badgeRect
    ? centerOf(badgeRect)
    : { x: rowRect.right - 24, y: rowRect.top + rowRect.height / 2 };
  const s0 = avatarRect.width || avatarRect.height || 1;
  const s1 = badgeRect && badgeRect.width > 0 ? badgeRect.width : 14;
  const mode = rowVisible ? 'full' : 'card';
  const animation = clone.animate(buildDispatchFlightKeyframes(p0, p1, p2, p3, s0, s1, mode), {
    duration: mode === 'full' ? DISPATCH_FLIGHT_MS : DISPATCH_FLIGHT_CARD_MS,
    easing: DISPATCH_FLIGHT_EASING,
    fill: 'forwards',
  });
  const previous = token.cancel;
  token.cancel = () => {
    animation.cancel();
    previous();
  };
  if (token.cancelled) animation.cancel();
  return animation.finished.then(
    () => undefined,
    () => undefined
  );
}

async function runOne(flight: Flight, token: CancelToken): Promise<void> {
  let clone: HTMLElement | null = null;
  try {
    if (token.cancelled || motionBlocked() || dispatchedToSecretary(flight.targetId)) return;
    const nodes = await waitForNodes(flight, token);
    if (!nodes || token.cancelled) return;
    clone = mountClone(nodes.avatar);
    if (token.cancelled) return;
    await playClone(clone, nodes, token);
  } finally {
    clone?.remove();
    useDispatchFlightStore.getState().removeFlight(flight.id);
  }
}

function startQueued(inflight: Set<string>, tokens: Map<string, CancelToken>): void {
  const store = useDispatchFlightStore.getState();
  let room =
    MAX_PLAYING -
    store.flights.filter((flight) => flight.state === 'playing' || inflight.has(flight.id)).length;
  for (const flight of store.flights) {
    if (room <= 0) break;
    if (flight.state !== 'mounting' || inflight.has(flight.id)) continue;
    room -= 1;
    const token = createToken();
    inflight.add(flight.id);
    tokens.set(flight.id, token);
    store.updateFlightState(flight.id, 'playing');
    void runOne(flight, token).finally(() => {
      inflight.delete(flight.id);
      tokens.delete(flight.id);
    });
  }
}

export function DispatchFlightLayer() {
  const flights = useDispatchFlightStore((state) => state.flights);
  const alive = useRef(true);
  const inflight = useRef(new Set<string>());
  const tokens = useRef(new Map<string, CancelToken>());

  useEffect(() => {
    alive.current = true;
    const active = tokens.current;
    return () => {
      alive.current = false;
      for (const token of active.values()) token.cancel();
    };
  }, []);

  useEffect(() => {
    if (!alive.current || flights.length === 0) return;
    const timer = setTimeout(() => {
      if (alive.current) startQueued(inflight.current, tokens.current);
    }, 0);
    return () => clearTimeout(timer);
  }, [flights]);

  return null;
}
