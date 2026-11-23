export interface DcgStatus {
  supported: boolean;
  installed: boolean;
  version: string;
}

export interface DcgActionResult {
  ok: boolean;
  status: DcgStatus;
  error?: string;
}

/** 手动「检查更新」结果；current 是 EnsoCode 内置（固定 sha256）的 dcg 版本 */
export type DcgUpdateCheck =
  | { status: 'latest'; current: string; latest: string }
  | { status: 'available'; current: string; latest: string }
  | { status: 'failed'; current: string; reason: 'network' | 'rate-limited' | 'invalid' };

export interface DcgRuleState {
  allowCount: number;
  exempt: boolean;
  suggestExempt: boolean;
}
