/** 项目：一个本地目录的引用，作为会话的工作目录 */
export interface Project {
  id: string;
  name: string;
  path: string;
}

/** 从本地编辑器 / 编程应用读到的最近打开目录 */
export interface RecentProject {
  path: string;
  displayPath: string;
  sourceName: string;
}
