import path from 'node:path';
import { app } from '@platform';
import { type PricingTable, parseUsageModelPricing } from '@shared/usage/pricing';
import { readSettings } from '../../ipc/settings';
import { getSharedWorktreeRegistry } from '../worktree/registry';
import {
  buildUsageProjectAliases,
  type UsageProjectAliases,
  type UsageProjectRef,
} from './projectLabel';

function settingsState(settings: Record<string, unknown> | null): Record<string, unknown> | null {
  const store = settings?.['enso-settings'];
  if (!store || typeof store !== 'object') return null;
  const state = (store as Record<string, unknown>).state;
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : null;
}

function readSettingsProjects(): UsageProjectRef[] {
  const projects = settingsState(readSettings())?.projects;
  if (!Array.isArray(projects)) return [];
  const out: UsageProjectRef[] = [];
  for (const raw of projects) {
    if (!raw || typeof raw !== 'object') continue;
    const project = raw as Record<string, unknown>;
    if (typeof project.id !== 'string' || !project.id) continue;
    if (typeof project.path !== 'string' || !project.path) continue;
    out.push({
      id: project.id,
      name: typeof project.name === 'string' ? project.name : '',
      path: project.path,
      ...(typeof project.alias === 'string' ? { alias: project.alias } : {}),
    });
  }
  return out;
}

export function loadUsageProjectAliases(): UsageProjectAliases {
  return buildUsageProjectAliases({
    projects: readSettingsProjects(),
    worktrees: getSharedWorktreeRegistry(
      path.join(app.getPath('userData'), 'worktrees.json')
    ).usageRecords(),
  });
}

export function loadUsageModelPricing(): PricingTable {
  return parseUsageModelPricing(settingsState(readSettings())?.usageModelPricing);
}
