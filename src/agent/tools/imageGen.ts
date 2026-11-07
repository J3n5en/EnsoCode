import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ImageGenerationState } from '@shared/imageGeneration';
import { type ApprovalGate, throwUnlessAllowed } from '../approval';
import { type EngineDeps, generate, type ImageArgs } from '../imageGeneration/engine';
import type { ConfirmOutsideImage } from './sendImage';

/** SSH 会话的参考图在 EnsoCode 本机，full 档只授权远端操作：上传本机文件按对外发送强制真人确认。 */
export function confirmImageReference(gate: ApprovalGate, remote: boolean): ConfirmOutsideImage {
  return async (file, signal, toolCallId) => {
    if (!remote && !gate.needsApproval('command', 'ImageGen')) return;
    throwUnlessAllowed(
      await gate.ask(
        'ImageGen',
        'command',
        `Upload a reference image from outside the workspace: ${file}`,
        signal,
        toolCallId,
        undefined,
        remote ? 'external-send' : undefined
      )
    );
  };
}

function normalize(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const args = { ...raw } as Record<string, unknown>;
  if (typeof args.prompt === 'string') args.prompt = args.prompt.trim();
  if (typeof args.count === 'string' && /^\d+$/.test(args.count.trim()))
    args.count = Number(args.count.trim());
  if (Array.isArray(args.referenceImages))
    args.referenceImages = args.referenceImages.map((v) => (typeof v === 'string' ? v.trim() : v));
  return args;
}
function validate(raw: unknown): ImageArgs {
  const v = normalize(raw);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid arguments');
  const a = v as Record<string, unknown>;
  if (Object.keys(a).some((k) => !['prompt', 'count', 'referenceImages'].includes(k)))
    throw new Error('Unexpected argument');
  if (typeof a.prompt !== 'string' || !a.prompt) throw new Error('Invalid prompt');
  if (
    a.count !== undefined &&
    (typeof a.count !== 'number' || !Number.isInteger(a.count) || a.count < 1 || a.count > 10)
  )
    throw new Error('Invalid count');
  if (
    a.referenceImages !== undefined &&
    (!Array.isArray(a.referenceImages) ||
      a.referenceImages.length > 10 ||
      a.referenceImages.some((v) => typeof v !== 'string' || !v))
  )
    throw new Error('Invalid references');
  return {
    prompt: a.prompt,
    count: (a.count as number | undefined) ?? 1,
    referenceImages: (a.referenceImages as string[] | undefined) ?? [],
  };
}
export function createImageGenTool(
  deps: EngineDeps & { getConfig: () => ImageGenerationState }
): ToolDefinition {
  return {
    name: 'ImageGen',
    label: 'ImageGen',
    description:
      'Generate and save images using the independent default image-generation model configured in settings. Only call when the user requests image generation or editing. Parameters: prompt, optional referenceImages (local workspace-relative, absolute or ~/ image paths), count (1–10, default 1). References outside the workspace may require approval. Even in SSH sessions, references and saved files are on the EnsoCode host. Saves under ~/.pi/scratch/<Pi Session ID>/ and returns each image index/status/path/mimeType; files are available only for success items. Successful images are automatically displayed to the user and attached to the conversation for you to see, including calls inside codemode; no read or image link is needed to display or inspect them. The latest generated batch stays in subsequent model context until replaced by a newer batch or removed by context compaction. Do not repeat a partially successful request automatically: it may charge again.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1 },
        referenceImages: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1 } },
        count: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['prompt'],
      additionalProperties: false,
    } as unknown as ToolDefinition['parameters'],
    prepareArguments: normalize as ToolDefinition['prepareArguments'],
    async execute(toolCallId, raw, signal, _onUpdate, ctx) {
      const fail = (message: string) => ({
        content: [
          { type: 'text' as const, text: JSON.stringify({ items: [], diagnostics: [message] }) },
        ],
        details: undefined,
        isError: true,
      });
      let state: ImageGenerationState;
      try {
        state = deps.getConfig();
      } catch {
        return fail('Image generation configuration is unavailable');
      }
      const config = state.config ? { ...state.config } : null;
      if (!config)
        return fail(
          state.error
            ? 'The selected image generation model is unavailable. Check its enabled state, image-generation flag, API key and protocol in Settings.'
            : 'Select a default image generation model in Settings first.'
        );
      let args: ImageArgs;
      try {
        args = validate(raw);
      } catch {
        return fail('Invalid ImageGen arguments');
      }
      const session = ctx?.sessionManager?.getSessionId?.();
      if (typeof session !== 'string') return fail('Missing session ID');
      const { images, ...result } = await generate(config, args, deps, session, toolCallId, signal);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }, ...images],
        details: undefined,
        ...(result.items.some((item) => item.status === 'success') ? {} : { isError: true }),
      };
    },
  };
}
