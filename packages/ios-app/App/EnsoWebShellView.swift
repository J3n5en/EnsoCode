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
                WebViewContainer(webView: controller.webView)
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

    func makeUIView(context: Context) -> WKWebView {
        webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
