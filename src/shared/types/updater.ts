/** 自动更新状态(main → 全部窗口广播,渲染层订阅) */
export interface UpdateStatus {
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
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
  /** downloaded 时：用户已要求重启，正等当前回合结束 */
  restartPending?: boolean;
}

/** 无界面服务端的更新途径：npm 为全局安装可自更新；manual（npx、不可写前缀）只报告新版本 */
export type ServerUpdateMode = 'npm' | 'manual';

/** 设置页打开时拉取一次（状态只靠推送的话，后连上的远端看不到已下载等状态） */
export interface UpdaterState {
  host: 'desktop' | 'server';
  status: UpdateStatus | null;
  mode?: ServerUpdateMode;
  /** 有进程守护（systemd）时才允许远程重启 */
  canRestart?: boolean;
}
