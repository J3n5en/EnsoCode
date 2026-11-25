import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetDispatchFlights,
  type FlightInput,
  noteDispatchFlight,
  useDispatchFlightStore,
} from './dispatchFlight';

function input(toolCallId: string): FlightInput {
  return {
    toolName: 'session_send',
    navKey: '0-0',
    targetId: `room-${toolCallId}`,
    projectId: 'sec',
    toolCallId,
  };
}

describe('dispatch flight store', () => {
  beforeEach(() => {
    _resetDispatchFlights();
  });

  it('按 toolCallId 去重，进行中的最多留 4 条', () => {
    const enqueue = useDispatchFlightStore.getState().enqueueDispatchFlight;
    enqueue(input('a'));
    enqueue(input('a'));
    expect(useDispatchFlightStore.getState().flights).toHaveLength(1);
    enqueue(input('b'));
    enqueue(input('c'));
    enqueue(input('d'));
    enqueue(input('e'));
    expect(useDispatchFlightStore.getState().flights.map((flight) => flight.toolCallId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    const done = useDispatchFlightStore.getState().flights[0];
    expect(done).toBeDefined();
    if (!done) return;
    useDispatchFlightStore.getState().updateFlightState(done.id, 'done');
    enqueue(input('e'));
    expect(useDispatchFlightStore.getState().flights).toHaveLength(5);
    useDispatchFlightStore.getState().removeFlight(done.id);
    expect(
      useDispatchFlightStore.getState().flights.some((flight) => flight.toolCallId === 'a')
    ).toBe(false);
  });

  it('update 改状态，remove 删掉', () => {
    useDispatchFlightStore.getState().enqueueDispatchFlight(input('a'));
    const flight = useDispatchFlightStore.getState().flights[0];
    expect(flight?.state).toBe('mounting');
    if (!flight) return;
    useDispatchFlightStore.getState().updateFlightState(flight.id, 'playing');
    expect(useDispatchFlightStore.getState().flights[0]?.state).toBe('playing');
    useDispatchFlightStore.getState().removeFlight(flight.id);
    expect(useDispatchFlightStore.getState().flights).toEqual([]);
  });

  it('只有秘书会话的派发结果会入队', () => {
    const projects = [
      { id: 'sec', kind: 'secretary' },
      { id: 'local', kind: 'local' },
    ];
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall' as const,
            id: 's',
            name: 'session_send',
            arguments: { conversationId: 'room-1' },
          },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 's',
        content: [{ type: 'text' as const, text: '{"status":"sent"}' }],
      },
    ];
    noteDispatchFlight({
      messages,
      historyBaseIndex: 0,
      projectId: 'local',
      toolCallId: 's',
      projects,
    });
    expect(useDispatchFlightStore.getState().flights).toEqual([]);
    noteDispatchFlight({
      messages,
      historyBaseIndex: 2,
      projectId: 'sec',
      toolCallId: 's',
      projects,
    });
    expect(useDispatchFlightStore.getState().flights[0]).toMatchObject({
      toolName: 'session_send',
      navKey: '2-0',
      targetId: 'room-1',
      projectId: 'sec',
      toolCallId: 's',
      state: 'mounting',
    });
  });
});
