/**
 * 手机目录可见性。store 依赖 DOM，node 环境不能导入，所以判定单独放在这里。
 * 秘书项目是 Main 登记的隐藏项目：它不是可选项目，它的会话也始终不进目录。
 */
export function catalogListedProject(kind?: string): boolean {
  return kind !== 'scratch' && kind !== 'secretary';
}

export function catalogHiddenProjectIds(
  projects: readonly { id: string; kind?: string }[],
  scratchSessionsEnabled: boolean
): Set<string> {
  return new Set(
    projects
      .filter(
        (project) =>
          project.kind === 'secretary' || (!scratchSessionsEnabled && project.kind === 'scratch')
      )
      .map((project) => project.id)
  );
}
