import SwiftUI
import UIKit

final class EnsoAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            EnsoPushManager.shared.didRegisterForRemoteNotifications(deviceToken: deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in
            EnsoPushManager.shared.didFailToRegisterForRemoteNotifications(error: error)
        }
    }
}

@main
struct EnsoCodeApp: App {
    @UIApplicationDelegateAdaptor(EnsoAppDelegate.self) private var appDelegate
    @StateObject private var controller = EnsoWebShellController()

    var body: some Scene {
        WindowGroup {
            EnsoWebShellView(controller: controller)
                .ignoresSafeArea()
                .onOpenURL { url in
                    controller.handleIncomingURL(url)
                }
        }
    }
}
