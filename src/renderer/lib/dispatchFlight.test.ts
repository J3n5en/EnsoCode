import type { ProjectedMessage, ProjectedPart } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  buildDispatchFlightKeyframes,
  detectDispatchFlight,
  headKeyOfRun,
  isSecretaryProject,
} from './dispatchFlight';

function call(id: string, name: string, args?: unknown): ProjectedPart {
  return { type: 'toolCall', id, name, arguments: args };
}

function assistant(
  parts: ProjectedPart[],
  extra: Partial<ProjectedMessage> = {}
): ProjectedMessage {
  return { role: 'assistant', content: parts, ...extra };
}

function result(toolCallId: string, text: string, isError = false): ProjectedMessage {
  return {
    role: 'toolResult',
    toolCallId,
    isError,
    content: text ? [{ type: 'text', text }] : [],
  };
}

function user(text: string): ProjectedMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('headKeyOfRun', () => {
  it('同一条消息里连续同名工具归到队首', () => {
    const messages = [
      assistant([
        call('a', 'session_send', { conversationId: 'c1' }),
        { type: 'text', text: '   ' },
        call('b', 'session_send', { conversationId: 'c2' }),
      ]),
    ];
    expect(headKeyOfRun(messages, 40, 0, 2, 'session_send')).toBe('40-0');
  });

  it('跨 toolResult 合并，正文、异名工具、图片和用户消息切断', () => {
    const merged = [
      user('go'),
      assistant([call('a', 'session_create')]),
      result('a', '{"status":"created","conversationId":"c1"}'),
      assistant([call('b', 'session_create')]),
    ];
    expect(headKeyOfRun(merged, 0, 3, 0, 'session_create')).toBe('1-0');

    const textBreak = [
      assistant([call('a', 'session_send'), { type: 'text', text: 'done' }]),
      result('a', '{"status":"sent"}'),
      assistant([call('b', 'session_send')]),
    ];
    expect(headKeyOfRun(textBreak, 0, 2, 0, 'session_send')).toBe('2-0');

    const otherTool = [
      assistant([
        call('a', 'session_send'),
        call('b', 'session_create'),
        call('c', 'session_send'),
      ]),
    ];
    expect(headKeyOfRun(otherTool, 0, 0, 2, 'session_send')).toBe('0-2');

    const imageBreak = [
      assistant([
        call('a', 'todo_item_dispatch'),
        { type: 'image', data: 'x', mimeType: 'image/png' },
        call('b', 'todo_item_dispatch'),
      ]),
    ];
    expect(headKeyOfRun(imageBreak, 0, 0, 2, 'todo_item_dispatch')).toBe('0-2');

    const thinking = [
      assistant([
        call('a', 'session_send'),
        { type: 'thinking', text: 'hmm' },
        call('b', 'session_send'),
      ]),
    ];
    expect(headKeyOfRun(thinking, 0, 0, 2, 'session_send')).toBe('0-2');
  });

  it('会画出的错误行切断跨消息合并', () => {
    const messages = [
      assistant([call('a', 'session_send')], { errorMessage: 'nope' }),
      result('a', '{"status":"sent"}'),
      assistant([call('b', 'session_send')]),
    ];
    expect(headKeyOfRun(messages, 0, 2, 0, 'session_send')).toBe('2-0');
  });
});

describe('detectDispatchFlight', () => {
  const base = 0;

  it('session_send 用参数里的会话，成功状态才飞', () => {
    const messages = [
      assistant([call('s', 'session_send', { conversationId: 'room-1' })]),
      result('s', '{"status":"steered"}'),
    ];
    expect(detectDispatchFlight(messages, base, 's')).toEqual({
      toolName: 'session_send',
      navKey: '0-0',
      targetId: 'room-1',
    });
    expect(
      detectDispatchFlight(
        [
          assistant([call('s', 'session_send', '{"conversationId":"room-2"}')]),
          result('s', '{"status":"sent"}'),
        ],
        base,
        's'
      )?.targetId
    ).toBe('room-2');
    expect(
      detectDispatchFlight(
        [
          assistant([call('s', 'session_send', { conversationId: 'room-1' })]),
          result('s', '{"status":"queued"}'),
        ],
        base,
        's'
      )?.targetId
    ).toBe('room-1');
  });

  it('session_send 没有输出时仍按参数触发，错误和未知状态不飞', () => {
    const callOnly = [assistant([call('s', 'session_send', { conversationId: 'room-1' })])];
    expect(detectDispatchFlight(callOnly, base, 's')?.targetId).toBe('room-1');
    expect(
      detectDispatchFlight(
        [
          assistant([call('s', 'session_send', { conversationId: 'room-1' })]),
          result('s', '', true),
        ],
        base,
        's'
      )
    ).toBeNull();
    expect(
      detectDispatchFlight(
        [
          assistant([call('s', 'session_send', { conversationId: 'room-1' })]),
          result('s', '{"status":"error"}'),
        ],
        base,
        's'
      )
    ).toBeNull();
    expect(
      detectDispatchFlight(
        [
          assistant([call('s', 'session_send', { conversationId: 'room-1' })]),
          result('s', 'not-json'),
        ],
        base,
        's'
      )
    ).toBeNull();
    expect(
      detectDispatchFlight([assistant([call('s', 'session_send', { text: 'hi' })])], base, 's')
    ).toBeNull();
  });

  it('session_create 和 todo_item_dispatch 只在 created 或 queued 时取输出里的会话', () => {
    const created = [
      assistant([call('c', 'session_create', { title: '新会话' })]),
      result('c', '{"status":"created","conversationId":"made-1"}'),
    ];
    expect(detectDispatchFlight(created, 3, 'c')).toEqual({
      toolName: 'session_create',
      navKey: '3-0',
      targetId: 'made-1',
    });
    expect(
      detectDispatchFlight(
        [
          assistant([call('d', 'todo_item_dispatch')]),
          result('d', '{"status":"queued","conversationId":"made-2"}'),
        ],
        base,
        'd'
      )
    ).toEqual({ toolName: 'todo_item_dispatch', navKey: '0-0', targetId: 'made-2' });
    for (const status of ['waiting', 'pending', 'failed']) {
      expect(
        detectDispatchFlight(
          [
            assistant([call('c', 'session_create')]),
            result('c', JSON.stringify({ status, conversationId: 'x' })),
          ],
          base,
          'c'
        )
      ).toBeNull();
    }
    expect(
      detectDispatchFlight(
        [
          assistant([call('c', 'session_create')]),
          result('c', '{"status":"created","conversationId":"x"}', true),
        ],
        base,
        'c'
      )
    ).toBeNull();
    expect(
      detectDispatchFlight([assistant([call('c', 'session_create')]), result('c', '{')], base, 'c')
    ).toBeNull();
  });

  it('找不到调用、或不是派发工具时不飞', () => {
    const messages = [assistant([call('b', 'bash', { command: 'ls' })]), result('b', 'ok')];
    expect(detectDispatchFlight(messages, base, 'missing')).toBeNull();
    expect(detectDispatchFlight(messages, base, 'b')).toBeNull();
  });

  it('合并后的 nav key 指向队首', () => {
    const messages = [
      assistant([
        call('a', 'session_send', { conversationId: 'first' }),
        call('b', 'session_send', { conversationId: 'second' }),
      ]),
      result('a', '{"status":"sent"}'),
      result('b', '{"status":"sent"}'),
    ];
    expect(detectDispatchFlight(messages, 0, 'b')?.navKey).toBe('0-0');
  });
});

describe('buildDispatchFlightKeyframes', () => {
  const p0 = { x: 10, y: 20 };
  const p1 = { x: 10, y: 120 };
  const p2 = { x: 110, y: 40 };
  const p3 = { x: 130, y: 40 };
  const frames = buildDispatchFlightKeyframes(p0, p1, p2, p3, 28, 14);

  it('偏移单调，并经过拱起、落地和缩小', () => {
    const offsets = frames.map((frame) => frame.offset);
    expect(offsets).toEqual([
      0, 0.06, 0.187, 0.22, 0.243, 0.39, 0.41, 0.53, 0.71, 0.745, 0.84, 0.86, 0.96, 1,
    ]);
    for (let index = 1; index < offsets.length; index += 1) {
      expect(offsets[index]).toBeGreaterThan(offsets[index - 1] ?? 0);
    }
    expect(frames[0]).toMatchObject({
      transform: 'translate(0px, 0px) scale(1) rotate(0deg)',
      opacity: 1,
    });
    expect(frames[1]?.transform).toBe('translate(0px, -24px) scale(1.1) rotate(-4deg)');
    expect(frames[2]?.transform).toBe('translate(0px, 100px) scale(1.16) rotate(0deg)');
    expect(frames[3]?.transform).toBe('translate(0px, 103px) scale(0.94) rotate(0deg)');
    expect(frames[5]?.transform).toBe('translate(0px, 100px) scale(1) rotate(0deg)');
    // 落卡落定亮相：0.22 之后位置完全停住，scale 缓缓收稳当呼吸，重复帧干脆收尾。
    for (const index of [4, 5, 6]) {
      expect(frames[index]?.transform).toContain('translate(0px, 100px)');
    }
    expect(frames[5]?.transform).toBe(frames[6]?.transform);
    expect(frames[7]?.transform).toBe('translate(26.9px, 40px) scale(0.75) rotate(3deg)');
    expect(frames[8]?.transform).toBe('translate(100px, 20px) scale(0.525) rotate(0deg)');
    // 行缘落定亮相：0.71 之后位置完全停住，scale 缓缓收稳，重复帧干脆收尾。
    for (const index of [9, 10, 11]) {
      expect(frames[index]?.transform).toContain('translate(100px, 20px)');
    }
    expect(frames[10]?.transform).toBe(frames[11]?.transform);
    expect(frames[12]).toMatchObject({
      transform: 'translate(125px, 20px) scale(0.5) rotate(0deg)',
      opacity: 1,
    });
    expect(frames[13]).toMatchObject({
      transform: 'translate(120px, 20px) scale(0.5) rotate(0deg)',
      opacity: 0,
    });
  });

  it('只到卡片时在落点淡出，偏移仍然单调', () => {
    const card = buildDispatchFlightKeyframes(p0, p1, p2, p3, 28, 14, 'card');
    const offsets = card.map((item) => Number(item.offset));
    for (let index = 1; index < offsets.length; index += 1) {
      expect(offsets[index]).toBeGreaterThan(offsets[index - 1] ?? 0);
    }
    expect(card.at(-1)).toMatchObject({ offset: 1, opacity: 0 });
    expect(card.at(-1)?.transform).toContain('translate(0px, 100px)');
  });
});

describe('isSecretaryProject', () => {
  const projects = [
    { id: 'sec', kind: 'secretary' },
    { id: 'local', kind: 'local' },
  ];

  it('只认 secretary 项目', () => {
    expect(isSecretaryProject(projects, 'sec')).toBe(true);
    expect(isSecretaryProject(projects, 'local')).toBe(false);
    expect(isSecretaryProject(projects, undefined)).toBe(false);
  });
});
