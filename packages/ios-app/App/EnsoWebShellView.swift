import SwiftUI
import WebKit

struct EnsoWebShellView: View {
    @ObservedObject var controller: EnsoWebShellController

    var body: some View {
        ZStack {
            if let error = controller.startupError {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.largeTitle)
                        .foregroundColor(.orange)
                    Text("EnsoCode 启动失败")
                        .font(.headline)
                    Text(error)
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                }
            } else {
                WebViewContainer(
                    webView: controller.webView,
                    pipSourceView: controller.pipSourceView,
                    onMovedToWindow: { controller.attachPiPViewIfNeeded() }
                )
            }
        }
        .onAppear {
            controller.startIfNeeded()
        }
        .fullScreenCover(isPresented: $controller.isShowingScanner) {
            NativeQrScannerView(
                onResult: { code in
                    controller.completeQrScan(with: code)
                },
                onCancel: {
                    controller.completeQrScan(with: nil)
                }
            )
        }
    }
}

private struct WebViewContainer: UIViewRepresentable {
    let webView: WKWebView
    let pipSourceView: UIView
    let onMovedToWindow: () -> Void

    func makeUIView(context: Context) -> ContainerView {
        let container = ContainerView()
        container.onMovedToWindow = onMovedToWindow
        webView.frame = container.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(webView)

        // 使用小尺寸行内占位视图作为 PiP 源，避免被 iOS 当作全屏播放器自动触发画中画
        pipSourceView.translatesAutoresizingMaskIntoConstraints = false
        pipSourceView.isUserInteractionEnabled = false
        container.addSubview(pipSourceView)
        NSLayoutConstraint.activate([
            pipSourceView.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            pipSourceView.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            pipSourceView.widthAnchor.constraint(equalToConstant: 170),
            pipSourceView.heightAnchor.constraint(equalToConstant: 110),
        ])
        return container
    }

    func updateUIView(_ uiView: ContainerView, context: Context) {
        uiView.onMovedToWindow = onMovedToWindow
    }

    /// 同时承载 WebView 与透明的画中画源视图（叠在最上层但不拦截触摸）。
    final class ContainerView: UIView {
        var onMovedToWindow: (() -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil {
                onMovedToWindow?()
            }
        }
    }
}
