/** 手机第二屏：renderer ↔ main 的 IPC 数据形状（不含加密实现，故不依赖 @enso/pair） */

export interface PairStatusDevice {
  pairId: string;
  deviceName: string;
  pairedAt: number;
  /** host 与中继的 WSS 是否已连上 */
  connected: boolean;
  /** 手机是否在房间里 */
  phoneOnline: boolean;
}

export interface PairStatus {
  relayUrl: string;
  pairing: boolean;
  /** 配对中的 QR 内容（enso://pair?...） */
  inviteUri?: string;
  /** 配对码过期时间戳（ms），用于 UI 倒计时 */
  pairingExpiresAt?: number;
  devices: PairStatusDevice[];
  /** safeStorage 是否可用；false 时 UI 必须提示密钥无法加密存储 */
  secureStorage: boolean;
}

/** renderer 推给 main 的目录快照。providers 必须已剥掉 apiKey/baseUrl。 */
export interface PairCatalogPayload {
  catalog: {
    id: string;
    title: string;
    projectName: string;
    projectId: string;
    status: string;
    parentId?: string;
    /** 最后活动时间（末条消息或创建时间） */
    updatedAt?: number;
  }[];
  projects: { id: string; name: string; path: string }[];
  providers: { id: string; name: string; models: { id: string; label?: string }[] }[];
  /** 仅供 main 侧 spawn 反查 cwd，不下发手机 */
  projectPaths: { id: string; path: string }[];
}
