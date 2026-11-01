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
