import type { RequestBodyUsage } from '@shared/requestBodyUsage';
import type { TFunction } from '@/i18n';
import { CRITICAL_PERCENT, type SegmentValue } from './usageSegments';

export function buildRequestBodySegment(
  t: TFunction,
  usage?: RequestBodyUsage
): SegmentValue | undefined {
  if (!usage) return undefined;
  const percent = Math.round((usage.bytes / usage.limitBytes) * 100);
  const phase = usage.blocked
    ? t('Blocked before send')
    : usage.stage === 'wire'
      ? t('Before send')
      : t('Serialized payload');
  return {
    compact: formatBytes(usage.bytes),
    full: `${formatBytes(usage.bytes)} / ${formatBytes(usage.limitBytes)} · ${percent}% · ${phase}`,
    critical: usage.blocked || percent >= CRITICAL_PERCENT,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
