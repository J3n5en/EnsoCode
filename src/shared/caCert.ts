export const CA_CERT_ENV = 'NODE_EXTRA_CA_CERTS';

export const CA_CERT_EXTENSIONS = ['pem', 'crt', 'cer'] as const;

/** env：启动时已存在（launchctl / 终端）；setting：设置项；shell：登录 shell 兜底 */
export type CaCertSource = 'env' | 'setting' | 'shell' | 'none';

export type CaCertError = 'not-absolute' | 'not-found' | 'not-file' | 'not-readable';

export interface CaCertStatus {
  source: CaCertSource;
  /** 当前生效的 NODE_EXTRA_CA_CERTS，未生效为空 */
  path: string;
  settingPath: string;
  /** 设置项指向的文件不可用（此时不设置 env） */
  error?: CaCertError;
}
