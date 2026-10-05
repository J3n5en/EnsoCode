import { imageSendErrorText } from '@shared/bots/sendImage';
import { translate } from '@shared/i18n';

/** host 按作用域拦截写命令时的错误码 */
export const READ_ONLY_ERROR = 'read-only';

export const rejectionText = (error?: string): string | undefined =>
  error === 'outbox-discarding'
    ? '正在移除…'
    : error === 'outbox-discard'
      ? '移除未保存，请勿关闭页面；请再次移除，重启后可能重新入队'
      : error === 'outbox-storage'
        ? '无法保存离线消息，请勿关闭页面；可重试或复制消息'
        : error === 'delivery-unconfirmed'
          ? '未收到回执，发送结果未确认；可重试确认'
          : error === READ_ONLY_ERROR
            ? '此设备为只读'
            : error
              ? translate('zh', imageSendErrorText(error) ?? error)
              : error;

/** 只读横幅；rejected = 刚有写操作被桌面拦下 */
export const readOnlyBanner = (rejected = false): string =>
  rejected
    ? '此设备为只读，刚才的操作未执行；可在桌面「设置 → 设备」切换为可操作'
    : '此设备为只读，只能查看；可在桌面「设置 → 设备」切换为可操作';
