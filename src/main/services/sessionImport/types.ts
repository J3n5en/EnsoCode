import type { ExternalSession } from '@shared/types/sessionImport';

/** Main 内部的扫描条目：带会话文件绝对路径，不出 Main */
export type ScannedSession = Omit<ExternalSession, 'token'> & { path: string };
