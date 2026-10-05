import type { ProtectedActionCategory } from '@shared/types/agent';

const LABELS: Record<ProtectedActionCategory, string> = {
  'external-send': 'Protected: external send',
  delete: 'Protected: delete',
  payment: 'Protected: payment',
  deploy: 'Protected: deploy / production',
  secret: 'Protected: secrets',
};

export function protectedActionLabel(
  category: ProtectedActionCategory,
  t: (key: string) => string
): string {
  return t(LABELS[category]);
}
