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
export { createBrowserDirectPeerFactory } from './direct/browserPeer';
export {
  CHUNK_PAYLOAD_BYTES,
  createReassembler,
  encodeChunks,
  type Reassembler,
} from './direct/chunk';
export {
  DIRECT_NEGOTIATE_TIMEOUT_MS,
  type DirectAction,
  type DirectEvent,
  type DirectPhase,
  type DirectRole,
  type DirectState,
  type DirectTransport,
  directBackoffDelay,
  initialDirectState,
  reduceDirect,
} from './direct/directSession';
export { DirectLink, type DirectLinkDeps, type DirectSignal } from './direct/link';
export { classifyNatMapping, describeCandidates, type NatMapping } from './direct/nat';
export {
  type DirectPeer,
  type DirectPeerFactory,
  isAllowedCandidate,
  normalizeCandidate,
} from './direct/peer';
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
export { attachHeartbeat, type Heartbeat, VISIBILITY_PROBE_MS } from './heartbeat';
export {
  pairProjectDisplayName,
  pairProjectListLabel,
  sshProjectLabel,
  toPairProjectEntry,
} from './projectEntry';
export {
  type ApprovalDecision,
  type ApprovalMode,
  type AttachedImage,
  type CatalogEntry,
  DIRECT_SIGNAL_MAX_CHARS,
  type DirectCandidate,
  type DirectCapability,
  type HostAppearance,
  type HostToPhone,
  type IceServerEntry,
  isPhoneCommand,
  type PairBotActivity,
  type PairBotActivityStep,
  type PairBotArtifact,
  type PairBotArtifactTarget,
  type PairBotChatState,
  type PairBotChatSummary,
  type PairBotEvent,
  type PairBotInboxItem,
  type PairBotMedia,
  type PairBotMember,
  type PairBotRunState,
  type PairControl,
  type PairDelegationState,
  type PairGroupEntry,
  type PairSessionSync,
  type PairSyncCursor,
  PHONE_COMMAND_TYPES,
  type PhoneToHost,
  type ProjectEntry,
  type ProjectGroupEntry,
  type ProviderEntry,
  type PushSubscriptionJson,
  type TerminalPalette,
  type ThinkingLevel,
} from './protocol';
export {
  backoffDelay,
  DEFAULT_RELAY_URL,
  normalizeRelayUrl,
  type PairedDevice,
  type PairScope,
  toWebSocketUrl,
} from './relay';
export {
  createCachedHostLookup,
  isConnectStuck,
  isForegroundSocketStale,
  isMagicDnsOnly,
  type NetworkInterfaceSnapshot,
  type NudgeReason,
  networkFingerprint,
  parseLiteralHost,
  parseRelayHostCache,
  parseResolvConfNameservers,
  parseScutilGlobalNameservers,
  pickRelayConnectAddress,
  RELAY_CONNECT_TIMEOUT_MS,
  type RelayHostAddress,
  serializeRelayHostCache,
  shouldReplaceOnNudge,
  shouldSkipRelayLookup,
  shouldUsePinnedRelaySocket,
  TAILSCALE_MAGIC_DNS,
} from './revive';
export { isPairSyncCursor, parsePairSessionSync } from './sessionSync';
export {
  decodeVoiceChunk,
  encodeVoiceChunks,
  VOICE_CHUNK_MAX_CHARS,
  VOICE_CHUNK_MAX_INDEX,
  VOICE_CHUNK_MAX_SAMPLES,
} from './voice';
