#!/usr/bin/env node
/**
 * Isolated userData with the built-in Mock provider (no real API keys).
 *
 *   node scripts/seed-mock-env.mjs /tmp/enso-mock
 *   ENSO_USER_DATA_DIR=/tmp/enso-mock pnpm dev
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const dir = process.argv[2];
if (!dir?.startsWith('/tmp/')) {
  console.error('usage: seed-mock-env.mjs /tmp/<name>  (must be under /tmp)');
  process.exit(2);
}

const provider = {
  id: 'mock-local',
  name: 'Mock',
  api: 'openai-completions',
  apiKey: 'enso-mock',
  baseUrl: 'enso-mock://local',
  enabled: true,
  catalogId: 'mock',
  models: [
    { id: 'mock-chat', label: 'Mock Chat', enabled: true },
    { id: 'mock-tools', label: 'Mock Tools', enabled: true },
  ],
};

const state = {
  providers: [provider],
  defaultModel: { providerId: 'mock-local', modelId: 'mock-chat' },
  onboarded: true,
  theme: 'dark',
  language: 'en',
};

mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/settings.json`, JSON.stringify({ 'enso-settings': { state, version: 10 } }));
mkdirSync(`${dir}-proj`, { recursive: true });
writeFileSync(
  `${dir}-proj/README.md`,
  '# Mock demo project\n\nLocal EnsoCode workspace for screenshot / chat demos.\n'
);
console.log(`ok: ${dir} + ${dir}-proj`);
console.log(`next: ENSO_USER_DATA_DIR=${dir} pnpm dev`);
