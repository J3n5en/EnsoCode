import EnsoCore
import Foundation
import UIKit
import UserNotifications

/// 管理原生 APNs 注册、端到端 Web Push 密钥（经 Keychain Access Group 与 NSE 共享）以及通知点击跳转。
@MainActor
final class EnsoPushManager: NSObject {
    static let shared = EnsoPushManager()

    private var currentTokenHex: String?
    private var pendingTokenContinuations: [CheckedContinuation<String, Error>] = []
    private var onOpenSession: ((String) -> Void)?
    private var pendingSessionId: String?

    private lazy var keyStore = SharedPushKeyStore(
        accessGroup: SharedPushKeyStore.resolvedAccessGroup()
    )

    func configure(onOpenSession: @escaping (String) -> Void) {
        self.onOpenSession = onOpenSession
        UNUserNotificationCenter.current().delegate = self
        if let pending = pendingSessionId {
            pendingSessionId = nil
            onOpenSession(pending)
        }
    }

    func apnsEnvironment() -> String {
        #if DEBUG
        return "sandbox"
        #else
        return "prod"
        #endif
    }

    func didRegisterForRemoteNotifications(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        currentTokenHex = hex
        let waiters = pendingTokenContinuations
        pendingTokenContinuations.removeAll()
        for c in waiters {
            c.resume(returning: hex)
        }
    }

    func didFailToRegisterForRemoteNotifications(error: Error) {
        let waiters = pendingTokenContinuations
        pendingTokenContinuations.removeAll()
        for c in waiters {
            c.resume(throwing: error)
        }
    }

    /// 申请系统通知权限并拿 APNs token + 本地 E2E 密钥，拼出标准 WebPushSubscription 字典回传前端。
    func subscribe(vapidPublicKey: String, gatewayOrigin: String) async -> [String: Any] {
        let vHash: String
        do {
            vHash = try WebPushCrypto.vapidKeyHash(vapidPublicKeyBase64Url: vapidPublicKey)
        } catch {
            return ["ok": false, "reason": "subscribe-failed"]
        }

        let center = UNUserNotificationCenter.current()
        let granted: Bool
        do {
            granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
        } catch {
            return ["ok": false, "reason": "permission-denied"]
        }
        guard granted else {
            return ["ok": false, "reason": "permission-denied"]
        }

        let tokenHex: String
        do {
            tokenHex = try await awaitDeviceToken(timeoutSeconds: 12)
        } catch {
            return ["ok": false, "reason": "subscribe-failed"]
        }

        let keys = keyStore.loadOrCreate()
        let cleanOrigin = gatewayOrigin.hasSuffix("/") ? String(gatewayOrigin.dropLast()) : gatewayOrigin
        let endpoint = "\(cleanOrigin)/v1/push/apns/\(apnsEnvironment())/\(tokenHex)?k=\(vHash)"
        return [
            "ok": true,
            "subscription": [
                "endpoint": endpoint,
                "keys": [
                    "p256dh": keys.p256dhBase64Url,
                    "auth": keys.authBase64Url,
                ],
            ],
        ]
    }

    func clearBadge() {
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(0, withCompletionHandler: nil)
        } else {
            UIApplication.shared.applicationIconBadgeNumber = 0
        }
    }

    private func awaitDeviceToken(timeoutSeconds: UInt64) async throws -> String {
        if let existing = currentTokenHex, !existing.isEmpty {
            return existing
        }
        UIApplication.shared.registerForRemoteNotifications()
        return try await withCheckedThrowingContinuation { continuation in
            self.pendingTokenContinuations.append(continuation)
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: timeoutSeconds * 1_000_000_000)
                guard let self, !self.pendingTokenContinuations.isEmpty else { return }
                let waiters = self.pendingTokenContinuations
                self.pendingTokenContinuations.removeAll()
                for c in waiters {
                    c.resume(throwing: URLError(.timedOut))
                }
            }
        }
    }
}

extension EnsoPushManager: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        return [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        let sessionId = userInfo["sessionId"] as? String
        await MainActor.run {
            self.clearBadge()
            guard let sessionId, !sessionId.isEmpty else { return }
            if let handler = self.onOpenSession {
                handler(sessionId)
            } else {
                self.pendingSessionId = sessionId
            }
        }
    }
}
