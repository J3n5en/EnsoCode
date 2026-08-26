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
}
