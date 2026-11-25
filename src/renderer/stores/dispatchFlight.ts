import type { ProjectedMessage } from '@shared/types/agent';
import { create } from 'zustand';
import {
  type DispatchFlightTool,
  detectDispatchFlight,
  isSecretaryProject,
} from '@/lib/dispatchFlight';

export interface Flight {
  id: string;
  toolName: DispatchFlightTool;
  navKey: string;
  targetId: string;
  projectId: string;
  toolCallId: string;
  state: 'mounting' | 'playing' | 'done';
}

export type FlightInput = Omit<Flight, 'id' | 'state'>;

const MAX_ACTIVE = 4;

let sequence = 0;

interface DispatchFlightState {
  flights: Flight[];
  enqueueDispatchFlight: (input: FlightInput) => void;
  updateFlightState: (id: string, state: Flight['state']) => void;
  removeFlight: (id: string) => void;
}

export const useDispatchFlightStore = create<DispatchFlightState>((set) => ({
  flights: [],
  enqueueDispatchFlight: (input) =>
    set((state) => {
      const queued = state.flights.some(
        (flight) => flight.toolCallId === input.toolCallId && flight.state !== 'done'
      );
      if (queued) return state;
      const active = state.flights.filter((flight) => flight.state !== 'done').length;
      if (active >= MAX_ACTIVE) return state;
      sequence += 1;
      const flight: Flight = { ...input, id: String(sequence), state: 'mounting' };
      return { flights: [...state.flights, flight] };
    }),
  updateFlightState: (id, next) =>
    set((state) => ({
      flights: state.flights.map((flight) =>
        flight.id === id ? { ...flight, state: next } : flight
      ),
    })),
  removeFlight: (id) =>
    set((state) => ({ flights: state.flights.filter((flight) => flight.id !== id) })),
}));

export function noteDispatchFlight(input: {
  messages: readonly ProjectedMessage[];
  historyBaseIndex: number;
  projectId: string;
  toolCallId: string;
  projects: readonly { id: string; kind?: string }[];
}): void {
  if (!isSecretaryProject(input.projects, input.projectId)) return;
  const hit = detectDispatchFlight(input.messages, input.historyBaseIndex, input.toolCallId);
  if (!hit) return;
  useDispatchFlightStore.getState().enqueueDispatchFlight({
    toolName: hit.toolName,
    navKey: hit.navKey,
    targetId: hit.targetId,
    projectId: input.projectId,
    toolCallId: input.toolCallId,
  });
}

export function _resetDispatchFlights(): void {
  sequence = 0;
  useDispatchFlightStore.setState({ flights: [] });
}
