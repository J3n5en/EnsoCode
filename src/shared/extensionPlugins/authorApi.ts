import type {
  EnsoEventData,
  EnsoHostApi,
  EnsoMcpTool,
  EnsoPluginManifest,
  EnsoSessionInfo,
  EnsoSlotRegistration,
  ExtensionPluginManifest as PublicManifest,
} from '../../../types/enso-plugin';
import type { McpToolInfo, PluginSessionInfo } from '../../main/services/extensionPlugins/gate';
import type { PluginSlotName } from '../../renderer/plugins/registry';
import type { ToolCallPayload, ToolResultPayload } from './events';
import type { ExtensionPluginManifest } from './manifest';
import type { PluginHostApi, PluginHostCapabilities } from './protocol';

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type AuthorKeys = Exclude<keyof EnsoPluginManifest, 'engines'>;
type ParsedKeys = Exclude<keyof ExtensionPluginManifest, 'ensoRange'>;

/** 和宿主类型对不齐时，typecheck 会失败。 */
const checks = [
  true as Assert<Equals<keyof EnsoHostApi, PluginHostApi>>,
  true as Assert<
    Equals<Awaited<ReturnType<EnsoHostApi['host.capabilities']>>, PluginHostCapabilities>
  >,
  true as Assert<Equals<EnsoSlotRegistration['slot'], PluginSlotName>>,
  true as Assert<Equals<EnsoSessionInfo, PluginSessionInfo>>,
  true as Assert<Equals<EnsoMcpTool, McpToolInfo>>,
  true as Assert<Equals<EnsoEventData['tool_call'], ToolCallPayload>>,
  true as Assert<Equals<EnsoEventData['tool_result'], ToolResultPayload>>,
  true as Assert<Equals<PublicManifest, ExtensionPluginManifest>>,
  true as Assert<Equals<AuthorKeys, ParsedKeys>>,
];
void checks;
