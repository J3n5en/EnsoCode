import type { PluginConfigType } from '@shared/extensionPlugins/manifest';

export function formatConfigValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** 设置表单的字符串或开关值 → 按配置项类型交给 Main 的值；null 表示清除 */
export function coerceConfigValue(
  field: { type: PluginConfigType; min?: number; max?: number; options?: string[] },
  input: string | boolean | null
): { ok: true; value: string | number | boolean | null } | { ok: false; error: string } {
  if (input === null) return { ok: true, value: null };
  if (field.type === 'boolean') {
    if (typeof input === 'boolean') return { ok: true, value: input };
    if (input === 'true' || input === 'false') return { ok: true, value: input === 'true' };
    return { ok: false, error: '需要打开或关闭' };
  }
  if (typeof input !== 'string') return { ok: false, error: '值不合法' };
  if (field.type === 'number') {
    const text = input.trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false, error: '需要数字' };
    const value = Number(text);
    if (!Number.isFinite(value)) return { ok: false, error: '需要数字' };
    if (field.min !== undefined && value < field.min) return { ok: false, error: '小于最小值' };
    if (field.max !== undefined && value > field.max) return { ok: false, error: '大于最大值' };
    return { ok: true, value };
  }
  if (field.type === 'enum') {
    if (!field.options?.includes(input)) return { ok: false, error: '不在可选项里' };
    return { ok: true, value: input };
  }
  if (input.length > 4096 || input.includes('\0')) return { ok: false, error: '值不合法' };
  return { ok: true, value: input };
}
