import type { ProjectedMessage, ProjectedPart } from '@shared/types/agent';

export const DISPATCH_FLIGHT_TOOLS = [
  'session_create',
  'session_send',
  'todo_item_dispatch',
] as const;

export type DispatchFlightTool = (typeof DISPATCH_FLIGHT_TOOLS)[number];

export interface DispatchFlightHit {
  toolName: DispatchFlightTool;
  navKey: string;
  targetId: string;
}

export interface FlightPoint {
  x: number;
  y: number;
}

export const DISPATCH_FLIGHT_MS = 3000;
export const DISPATCH_FLIGHT_EASING = 'cubic-bezier(0.45, 0, 0.2, 1)';
// 弧线飞行与落定用柔和慢入慢出，挤压回弹用快出慢入。
const FLOAT_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
const SETTLE_EASING = 'cubic-bezier(0.3, 0, 0.15, 1)';
// 只飞到卡片时走完落定亮相（offset 0.39），剩余部分用于淡出。
export const DISPATCH_FLIGHT_CARD_PORTION = 0.47;
export const DISPATCH_FLIGHT_CARD_MS = Math.round(
  DISPATCH_FLIGHT_MS * DISPATCH_FLIGHT_CARD_PORTION
);

/** handshake 轮询。测试可改这两个字段。 */
export const dispatchFlightTiming = {
  intervalMs: 50,
  timeoutMs: 1200,
};

const SEND_OK = new Set(['sent', 'steered', 'queued']);
const CREATE_OK = new Set(['created', 'queued']);

export function isSecretaryProject(
  projects: readonly { id: string; kind?: string }[],
  projectId: string | undefined
): boolean {
  if (!projectId) return false;
  return projects.some((project) => project.id === projectId && project.kind === 'secretary');
}

function isDispatchTool(name: string): name is DispatchFlightTool {
  return (DISPATCH_FLIGHT_TOOLS as readonly string[]).includes(name);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function stringField(source: unknown, key: string): string | null {
  const record =
    asRecord(source) ?? (typeof source === 'string' ? asRecord(parseJson(source)) : null);
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function resultOutput(
  messages: readonly ProjectedMessage[],
  toolCallId: string
): { found: boolean; isError: boolean; text: string } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'toolResult' || message.toolCallId !== toolCallId) continue;
    const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    return { found: true, isError: message.isError === true, text };
  }
  return { found: false, isError: false, text: '' };
}

function targetOf(
  messages: readonly ProjectedMessage[],
  part: Extract<ProjectedPart, { type: 'toolCall' }>
): string | null {
  if (part.name === 'session_send') {
    const targetId = stringField(part.arguments, 'conversationId');
    if (!targetId) return null;
    const output = resultOutput(messages, part.id);
    if (output.isError) return null;
    if (!output.found || output.text.trim() === '') return targetId;
    const body = asRecord(parseJson(output.text));
    const status = typeof body?.status === 'string' ? body.status : '';
    return SEND_OK.has(status) ? targetId : null;
  }
  const output = resultOutput(messages, part.id);
  if (!output.found || output.isError) return null;
  const body = asRecord(parseJson(output.text));
  const status = typeof body?.status === 'string' ? body.status : '';
  if (!CREATE_OK.has(status)) return null;
  return stringField(body, 'conversationId');
}

type PartGate = 'continue' | 'skip' | 'stop';

/** 不渲染成行的 part 不切断合并；其余切断。 */
function gatePart(part: ProjectedPart, toolName: string): PartGate {
  if (part.type === 'toolCall') return part.name === toolName ? 'continue' : 'stop';
  if (part.type === 'text') return part.text.trim() ? 'stop' : 'skip';
  if (part.type === 'thinking') return part.text ? 'stop' : 'skip';
  if (part.type === 'image') return 'stop';
  return 'skip';
}

/**
 * 连续同名工具卡合并后，时间线只保留队首的 nav key。
 * toolResult 不占行。非空正文、异名工具、图片、用户消息和会画出的错误行都会切断。
 */
export function headKeyOfRun(
  messages: readonly ProjectedMessage[],
  historyBaseIndex: number,
  startMessageIndex: number,
  startPartIndex: number,
  toolName: string
): string {
  let headMessage = startMessageIndex;
  let headPart = startPartIndex;
  let messageIndex = startMessageIndex;
  let partIndex = startPartIndex;

  while (messageIndex >= 0 && messageIndex < messages.length) {
    if (partIndex > 0) {
      const part = messages[messageIndex]?.content[partIndex - 1];
      if (!part) break;
      const gate = gatePart(part, toolName);
      if (gate === 'stop') break;
      partIndex -= 1;
      if (gate === 'continue') {
        headMessage = messageIndex;
        headPart = partIndex;
      }
      continue;
    }
    let previous = messageIndex - 1;
    while (previous >= 0 && messages[previous]?.role === 'toolResult') previous -= 1;
    if (previous < 0) break;
    const message = messages[previous];
    if (message?.role !== 'assistant' || message?.errorMessage) break;
    messageIndex = previous;
    partIndex = message.content.length;
  }

  return `${historyBaseIndex + headMessage}-${headPart}`;
}

export function detectDispatchFlight(
  messages: readonly ProjectedMessage[],
  historyBaseIndex: number,
  toolCallId: string
): DispatchFlightHit | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.role !== 'assistant') continue;
    const partIndex = message.content.findIndex(
      (part) => part.type === 'toolCall' && part.id === toolCallId
    );
    if (partIndex < 0) continue;
    const part = message.content[partIndex];
    if (part?.type !== 'toolCall' || !isDispatchTool(part.name)) return null;
    const targetId = targetOf(messages, part);
    if (!targetId) return null;
    return {
      toolName: part.name,
      navKey: headKeyOfRun(messages, historyBaseIndex, messageIndex, partIndex, part.name),
      targetId,
    };
  }
  return null;
}

interface Pose {
  offset: number;
  at: FlightPoint;
  scale: number;
  rotate: number;
  opacity: number;
  easing?: string;
}

function rounded(value: number, places: number): number {
  const unit = 10 ** places;
  return Math.round(value * unit) / unit;
}

function frame(origin: FlightPoint, pose: Pose): Keyframe {
  const x = rounded(pose.at.x - origin.x, 1);
  const y = rounded(pose.at.y - origin.y, 1);
  const scale = rounded(pose.scale, 3);
  return {
    offset: pose.offset,
    transform: `translate(${x}px, ${y}px) scale(${scale}) rotate(${pose.rotate}deg)`,
    opacity: pose.opacity,
    ...(pose.easing ? { easing: pose.easing } : {}),
  };
}

function arcUp(from: FlightPoint, to: FlightPoint): FlightPoint {
  return {
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2 - (Math.abs(to.y - from.y) * 0.5 + 24),
  };
}

function arcLeft(from: FlightPoint, to: FlightPoint): FlightPoint {
  const bulge = Math.min(Math.hypot(to.x - from.x, to.y - from.y) * 0.18, 40);
  return {
    x: (from.x + to.x) / 2 - bulge,
    y: (from.y + to.y) / 2 - 20,
  };
}

export function buildDispatchFlightKeyframes(
  p0: FlightPoint,
  p1: FlightPoint,
  p2: FlightPoint,
  p3: FlightPoint,
  s0: number,
  s1: number,
  mode: 'full' | 'card' = 'full'
): Keyframe[] {
  const endScale = s0 > 0 ? s1 / s0 : 1;
  const poses: Pose[] = [
    { offset: 0, at: p0, scale: 1, rotate: 0, opacity: 1 },
    {
      offset: 0.06,
      at: arcUp(p0, p1),
      scale: 1.1,
      rotate: -4,
      opacity: 1,
      easing: FLOAT_EASING,
    },
    { offset: 0.187, at: p1, scale: 1.16, rotate: 0, opacity: 1, easing: FLOAT_EASING },
    { offset: 0.22, at: { x: p1.x, y: p1.y + 3 }, scale: 0.94, rotate: 0, opacity: 1 },
    // 落定亮相：位置完全停住，scale 回弹后缓缓收稳当呼吸；重复帧让结束干脆利落，
    // 避免整体缓动把动身往亮相里渗。
    { offset: 0.243, at: p1, scale: 1.04, rotate: 0, opacity: 1, easing: SETTLE_EASING },
    { offset: 0.39, at: p1, scale: 1, rotate: 0, opacity: 1 },
    { offset: 0.41, at: p1, scale: 1, rotate: 0, opacity: 1 },
    {
      offset: 0.53,
      at: arcLeft(p1, p2),
      scale: (1 + endScale) / 2,
      rotate: 3,
      opacity: 1,
      easing: FLOAT_EASING,
    },
    {
      offset: 0.71,
      at: p2,
      scale: endScale * 1.05,
      rotate: 0,
      opacity: 1,
      easing: FLOAT_EASING,
    },
    // 行缘落定亮相：位置完全停住只靠 scale 缓缓收稳，重复帧干脆收尾，
    // 之后 420ms 滑向徽标归位淡出。
    { offset: 0.745, at: p2, scale: endScale, rotate: 0, opacity: 1, easing: SETTLE_EASING },
    { offset: 0.84, at: p2, scale: endScale, rotate: 0, opacity: 1 },
    { offset: 0.86, at: p2, scale: endScale, rotate: 0, opacity: 1 },
    { offset: 0.96, at: { x: p3.x + 5, y: p3.y }, scale: endScale, rotate: 0, opacity: 1 },
    { offset: 1, at: p3, scale: endScale, rotate: 0, opacity: 0 },
  ];
  if (mode === 'full') return poses.map((pose) => frame(p0, pose));
  const kept = poses.filter((pose) => pose.offset <= 0.39);
  const landed = kept[kept.length - 1] ?? poses[0];
  return [
    ...kept.map((pose) =>
      frame(p0, { ...pose, offset: pose.offset / DISPATCH_FLIGHT_CARD_PORTION })
    ),
    frame(p0, { ...landed, offset: 1, scale: 1, rotate: 0, opacity: 0 }),
  ];
}
