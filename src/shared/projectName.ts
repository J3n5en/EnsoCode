/** 目录路径的最后一段作为项目名；同时兼容 posix 与 Windows 分隔符 */
export function projectNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * 展示名优先级：用户别名 > 存储名；历史数据里 Windows 项目名被存成了完整路径，这种情况重新推导。
 * 别名只有去空白后非空才生效，避免空串把项目名抹成空白。
 */
export function projectDisplayName(project: {
  name: string;
  path: string;
  alias?: string;
}): string {
  const alias = project.alias?.trim();
  if (alias) return alias;
  return project.name === project.path ? projectNameFromPath(project.path) : project.name;
}
