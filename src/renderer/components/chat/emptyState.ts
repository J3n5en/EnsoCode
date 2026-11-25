/**
 * 空会话大标题。秘书会话属于哪个秘书就写哪个秘书的名字，
 * 不能露出隐藏项目名「Secretary」；档案还没加载好时回退到调用方给的标题。
 */
export function emptyStateTitle({
  secretarySession,
  ownerName,
  fallback,
}: {
  secretarySession: boolean;
  ownerName: string | null | undefined;
  fallback: string;
}): string {
  if (!secretarySession) return fallback;
  const name = ownerName?.trim();
  return name || fallback;
}
