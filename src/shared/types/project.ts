/** 项目：本地目录或 ssh 远程目录的引用，作为会话的工作目录 */
export interface Project {
  id: string;
  name: string;
  path: string;
  /** 缺省 local;ssh 项目的工具调用全部在远端执行 */
  kind?: 'local' | 'ssh';
  /** kind='ssh' 时的 ssh 目标(user@host 或 ssh config 别名) */
  sshHost?: string;
  sshConnectionId?: string;
}

/** 从本地编辑器 / 编程应用读到的最近打开目录 */
export interface RecentProject {
  path: string;
  displayPath: string;
  sourceName: string;
}
