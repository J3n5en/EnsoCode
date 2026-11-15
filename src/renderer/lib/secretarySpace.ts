/**
 * 秘书私有记忆空间 id。renderer 不能 import Main，格式与 Main 的 `projectSpaceId` 对齐，
 * 由 secretarySpace.test.ts 守住两边一致。
 */
export function secretarySpaceId(projectId: string): string {
  return `proj:${projectId}`;
}
