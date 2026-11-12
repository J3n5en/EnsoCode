export const PARENT_GENERATION = '11111111-1111-4111-8111-111111111111';
export const CHILD_GENERATION = '22222222-2222-4222-8222-222222222222';
export const INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
export const RECEIPT_ID = '44444444-4444-4444-8444-444444444444';
export const SPAWN_SPEC_ID = '55555555-5555-4555-8555-555555555555';
export const DISPATCH_ID = '66666666-6666-4666-8666-666666666666';

export const parent = { sessionId: 'conversation-1', generation: PARENT_GENERATION } as const;
export const child = {
  sessionId: 'conversation-1::cw-33333333',
  generation: CHILD_GENERATION,
  parent,
  instanceId: INSTANCE_ID,
  instanceName: 'scout 3333',
  typeKey: 'builtin:scout',
} as const;
/** 历史 Enso child：只用于读兼容（metadata / receipt / safe journal）断言 */
export const legacyEnsoChild = {
  ...child,
  instanceName: 'Enso 3333',
  typeKey: 'agent:enso',
  profileId: 'enso-locked-v1',
} as const;
export const model = {
  api: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'k',
  modelId: 'gpt',
  settingsProviderId: 'provider-entry-1',
};
export const task = { text: 'Configure theme', images: [], fileMentions: [] };
export const proof = {
  spawnSpecId: SPAWN_SPEC_ID,
  typeKey: 'builtin:scout',
  model: { providerId: 'p', modelId: 'm' },
  toolIds: ['read', 'grep'],
  loadedSkillBindingIds: [],
  loadedMcpBindingIds: [],
  systemPromptHash: 'sha256:locked-prompt',
};
export const receipt = {
  receiptId: RECEIPT_ID,
  operationId: 'op-1',
  child: legacyEnsoChild,
  turnId: 'turn-1',
  requestId: 'cap-1',
  capabilityId: 'appearance.theme',
  risk: 'reversible',
  subject: { kind: 'setting', id: 'theme', label: 'Theme' },
  outcome: 'succeeded',
  summary: 'Theme changed',
  changes: [{ field: 'theme', previous: 'light', value: 'dark' }],
  occurredAt: 1,
  sequence: 0,
};
