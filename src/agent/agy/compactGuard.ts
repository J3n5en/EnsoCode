import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  InlineExtension,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from '@earendil-works/pi-coding-agent';
import { takeCompactCancel } from '../ensoCompact/cancel';
import { createEnsoCompactHandler } from '../ensoCompact/extension';
import { isAgyModel } from './provider';

type CompactHandler = (
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext
) => Promise<SessionBeforeCompactResult | undefined> | SessionBeforeCompactResult | undefined;

/**
 * agy 会话的压缩不能落到 pi 原生摘要：原生会拿会话模型总结（含 turn prefix 摘要），agy 的桥拒绝这类请求，
 * 用户只看到「压缩失败」。agy 的上下文由 agy 自己管，这次压缩只裁 Enso 自己的记录。
 *
 * pi 的 ExtensionRunner 对 session_before_compact 按注册顺序跑完所有处理器：后一个非空结果覆盖前一个，
 * `cancel` 立即返回、后面的不再跑。单独挂在 Enso 处理器后面的兜底分不清前面有没有给结果，
 * 所以包住 Enso 的处理器：它对 agy 会话给不出结果（太短、切点落在一轮中间、准备失败、抛错）时，
 * 换本地确定性摘要；本地也做不了就取消。其他模型原样交给 pi。
 */
function guard(inner: CompactHandler): CompactHandler {
  const local = createEnsoCompactHandler();
  return async (event, ctx) => {
    const agy = ctx.model !== undefined && isAgyModel(ctx.model);
    if (!agy) return inner(event, ctx);
    let result: SessionBeforeCompactResult | undefined;
    try {
      result = (await inner(event, ctx)) ?? undefined;
    } catch (error) {
      console.warn('[agy] compaction handler failed, using local summary:', error);
    }
    if (!result && !event.signal.aborted) {
      try {
        result = (await local(event, ctx)) ?? undefined;
      } catch (error) {
        console.warn('[agy] local compaction summary failed:', error);
      }
    }
    if (result?.compaction) return result;
    // 自动压缩（溢出 / 阈值）被取消不提示：agy 自己管上下文，这里压不压都不影响它。
    // supervisor 会把钩子留下的取消原因当错误弹 toast，自动的就清掉；手动压缩保留原因
    if (event.reason !== 'manual') takeCompactCancel(ctx.sessionManager);
    return { cancel: true };
  };
}

function factoryOf(extension: InlineExtension): ExtensionFactory {
  return typeof extension === 'function' ? extension : extension.factory;
}

type NamedExtension = Exclude<InlineExtension, ExtensionFactory>;

/** 给一个压缩扩展的 session_before_compact 处理器套上 agy 兜底；它注册的其他事件原样透传 */
export function withAgyCompactGuard(extension: InlineExtension): NamedExtension {
  const factory = factoryOf(extension);
  const wrapped: ExtensionFactory = (pi: ExtensionAPI) => {
    const on = ((name: string, handler: unknown) =>
      pi.on(
        name as never,
        (name === 'session_before_compact' ? guard(handler as CompactHandler) : handler) as never
      )) as ExtensionAPI['on'];
    const proxy = new Proxy(pi, {
      get(target, property) {
        if (property === 'on') return on;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return factory(proxy);
  };
  return typeof extension === 'function'
    ? { name: 'agy-compact-guard', hidden: true, factory: wrapped }
    : { ...extension, factory: wrapped };
}

/** standard 策略没有 Enso 压缩扩展：只挂兜底，agy 会话换本地摘要 */
export const agyCompactGuardExtension = withAgyCompactGuard({
  name: 'agy-compact-guard',
  hidden: true,
  factory: (pi: ExtensionAPI) => {
    pi.on('session_before_compact', () => undefined);
  },
});
