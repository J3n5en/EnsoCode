import SwiftUI

@main
struct EnsoCodeApp: App {
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
