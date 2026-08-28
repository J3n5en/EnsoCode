// 显式具名导出（不用 export *）：export * 会让 rollup 生成 __exportAll 运行时 helper，
// 该 helper 被提进 main 入口后，agent worker 的共享 chunk 会反向 import main，
// 导致 utilityProcess 里加载 electron-toolkit 而崩溃。
export {
  type BoxedContentKey,
  boxContentKey,
  generateContentKey,
  generatePairKeypair,
  openBoxedContentKey,
  openFrame,
  PairCryptoError,
  type PairKeypair,
  sealFrame,
} from './crypto';
export {
  buildPairLink,
  buildPairUri,
  fromBase64Url,
  type PairInvite,
  parsePairUri,
  toBase64Url,
} from './encoding';
export {
  claimPairing,
  decodeBoxedKey,
  encodeBoxedKey,
  type HostPairResult,
  type HostPairSession,
  type PhonePairResult,
  pollHostPairing,
  revokePairing,
  startHostPairing,
} from './handshake';
export {
  type ApprovalDecision,
  type ApprovalMode,
  type AttachedImage,
  type CatalogEntry,
  type HostAppearance,
  type HostToPhone,
  isPhoneCommand,
  type PairControl,
  PHONE_COMMAND_TYPES,
  type PhoneToHost,
  type ProjectEntry,
  type ProviderEntry,
  type TerminalPalette,
  type ThinkingLevel,
} from './protocol';
export {
  backoffDelay,
  DEFAULT_RELAY_URL,
  normalizeRelayUrl,
  type PairedDevice,
  toWebSocketUrl,
} from './relay';
