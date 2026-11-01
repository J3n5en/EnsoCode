import type { PluginArtifactInfo } from './protocol';

const ARTIFACT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PLUGIN_ID = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;

export function parsePluginArtifactInfo(raw: unknown): PluginArtifactInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !ARTIFACT_ID.test(value.id)) return null;
  if (
    typeof value.pluginId !== 'string' ||
    value.pluginId.length > 40 ||
    !PLUGIN_ID.test(value.pluginId)
  )
    return null;
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 256)
    return null;
  if (typeof value.mime !== 'string' || value.mime.length === 0 || value.mime.length > 128)
    return null;
  if (typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size < 0) return null;
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return null;
  return {
    id: value.id,
    pluginId: value.pluginId,
    name: value.name,
    mime: value.mime,
    size: value.size,
    createdAt: value.createdAt,
  };
}

/** 插件工具结果 details = { details, artifacts }；缺字段的条目丢掉 */
export function pluginArtifactsFromToolDetails(details: unknown): PluginArtifactInfo[] {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return [];
  const raw = (details as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = parsePluginArtifactInfo(item);
    return parsed ? [parsed] : [];
  });
}
