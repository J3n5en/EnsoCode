import EnsoCore
import UserNotifications
import WidgetKit

/// iOS Notification Service Extension：
/// 拦截带有 `mutable-content: 1` 的 APNs 远程通知，从共享 Keychain 取出本机 P-256 ECDH 私钥，
/// 在本机解密 RFC 8291 (`aes128gcm`) 密文并还原标题、正文、会话 ID 与角标。中继全程看不到明文。
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        guard let bestAttempt = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        self.bestAttemptContent = bestAttempt

        if let enso = bestAttempt.userInfo["enso"] as? [String: Any],
           let cipherB64 = enso["c"] as? String,
           !cipherB64.isEmpty
        {
            let store = SharedPushKeyStore(accessGroup: SharedPushKeyStore.resolvedAccessGroup())
            if let keys = store.load(),
               let payload = try? WebPushCrypto.decryptPushPayload(ciphertextBase64: cipherB64, keys: keys)
            {
                bestAttempt.title = payload.title
                bestAttempt.body = payload.body
                bestAttempt.threadIdentifier = payload.sessionId
                var userInfo = bestAttempt.userInfo
                userInfo["sessionId"] = payload.sessionId
                userInfo["pending"] = payload.pending
                bestAttempt.userInfo = userInfo
                if payload.pending {
                    bestAttempt.interruptionLevel = .timeSensitive
                }
                // 后台推送解密成功后同步刷新主屏/锁屏小组件共享快照
                _ = SharedWidgetStore.shared.mergePushNotification(
                    title: payload.title,
                    body: payload.body,
                    sessionId: payload.sessionId,
                    pending: payload.pending
                )
                WidgetCenter.shared.reloadAllTimelines()
            }
        }

        contentHandler(bestAttempt)
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let bestAttemptContent {
            contentHandler(bestAttemptContent)
        }
    }
}
