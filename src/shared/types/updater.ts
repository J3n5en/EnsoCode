/** 自动更新状态(main → 全部窗口广播,渲染层订阅) */
export interface UpdateStatus {
  status:
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'applying'
    | 'error';
  /** available/downloaded 时携带的版本信息(白名单可序列化字段) */
  info?: {
    version: string;
    releaseNotes?: string;
    releaseName?: string;
  };
  /** downloading 时的进度 */
  progress?: {
    percent: number;
    bytesPerSecond: number;
    total: number;
    transferred: number;
  };
  error?: string;
  /** 本地构建签名与正式包不一致、无法自动安装时，改给手动下载入口 */
  manualInstall?: ManualInstall;
  /** applying 时的阶段与等待详情（服务端优雅重启用） */
  applying?: {
    stage: 'waiting-tasks' | 'installing' | 'restarting';
    /** 还在跑回合的工作区数（waiting-tasks 阶段） */
    busyCount?: number;
    /** 等待上限的截止时刻（epoch ms）；超时后安全中断并续跑 */
    deadlineMs?: number;
  };
}

export interface ManualInstall {
  version?: string;
  releaseUrl: string;
  downloadUrl?: string;
}

/** 重启更新的受理结果：没装成时渲染层据此提示 */
export type RestartToUpdateResult =
  | { ok: true }
  | { ok: false; reason: 'not-downloaded' | 'busy' }
  | { ok: false; reason: 'error'; error: string };

/** 手动检查更新的结果：渲染层据此提示，不能再只靠被吞掉的副作用 */
export type UpdateCheckResult =
  | { ok: true; status: 'up-to-date' | 'available' | 'downloaded' | 'unsupported' }
  | { ok: false; error: string };

/** 无界面服务端的更新途径：npm 为全局安装可自更新；manual（npx、不可写前缀）只报告新版本 */
export type ServerUpdateMode = 'npm' | 'manual';

/** 服务端重启自身的方式：supervisor 由 systemd/pm2 等守护拉起；reexec 无守护时自己拉自己；manual 容器等场景只能外部重启 */
export type ServerRestartMethod = 'supervisor' | 'reexec' | 'manual';

/** 设置页打开时拉取一次（状态只靠推送的话，后连上的远端看不到已下载等状态） */
export interface UpdaterState {
  host: 'desktop' | 'server';
  status: UpdateStatus | null;
  mode?: ServerUpdateMode;
  /** 有进程守护（systemd）时才允许远程重启 */
  canRestart?: boolean;
  /** 服务端怎么重启自己；canRestart 等价于 restartMethod !== 'manual'（保留 canRestart 兼容旧远端） */
  restartMethod?: ServerRestartMethod;
  /** 服务端按渠道查 npm dist-tag；桌面端无此字段（渠道由 electron-updater 侧维护） */
  channel?: 'stable' | 'beta';
}
