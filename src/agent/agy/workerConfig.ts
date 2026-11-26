import type { AgyModelOption } from '@shared/agy/types';

export interface AgyWorkerConfig {
  binaryPath: string;
  skipPermissions: boolean;
  models: AgyModelOption[];
}

const EMPTY: AgyWorkerConfig = { binaryPath: '', skipPermissions: false, models: [] };

let current: AgyWorkerConfig = EMPTY;

export function getAgyWorkerConfig(): AgyWorkerConfig {
  return current;
}

export function setAgyWorkerConfig(next: AgyWorkerConfig): void {
  current = {
    binaryPath: next.binaryPath.trim(),
    skipPermissions: next.skipPermissions === true,
    models: next.models.filter((model) => model.id),
  };
}
