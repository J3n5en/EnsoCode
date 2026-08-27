import type { ModelApiKind } from '@shared/types';
import type { FontWeight } from '@/stores/settings';

export type SettingsCategory =
  | 'general'
  | 'appearance'
  | 'providers'
  | 'skills'
  | 'mcp'
  | 'instructions'
  | 'presets'
  | 'agents'
  | 'tools';

/** API 协议取值 → 设置页展示名；列表徽章与编辑弹窗共用。 */
export const API_KIND_LABELS: Record<ModelApiKind, string> = {
  'openai-completions': 'OpenAI Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic',
  'google-generative-ai': 'Gemini',
  ollama: 'Ollama',
};

export const fontWeightOptions: { value: FontWeight; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: '100', label: '100 (Thin)' },
  { value: '200', label: '200 (Extra Light)' },
  { value: '300', label: '300 (Light)' },
  { value: '400', label: '400 (Regular)' },
  { value: '500', label: '500 (Medium)' },
  { value: '600', label: '600 (Semi Bold)' },
  { value: '700', label: '700 (Bold)' },
  { value: '800', label: '800 (Extra Bold)' },
  { value: '900', label: '900 (Black)' },
  { value: 'bold', label: 'Bold' },
];
