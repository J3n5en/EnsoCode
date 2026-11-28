import EnsoCore
import Foundation
import SwiftUI
import UIKit
import WebKit

/// 负责协调：
/// - 本机嵌入式 `LocalWebServer`（托管打包进 App 的 `WebApp` 静态文件 + `/desk/*` 加密隧道代理）
/// - `WKWebView` 与 `window.__ensoNative` 原生 JS 桥接
/// - `QuicRelayConnection` 多连接管理（iOS 原生 `NWProtocolQUIC` 多流 + 自动网络迁流）
/// - 原生 AVFoundation 二维码扫码与前后台生命周期唤醒
@MainActor
final class EnsoWebShellController: NSObject, ObservableObject {
    @Published var isShowingScanner = false
    @Published var startupError: String?

    let webView: WKWebView
    private let bridgeHandler = WeakScriptMessageHandler()
    private var server: LocalWebServer?
    private var quicConnections: [String: QuicRelayConnection] = [:]
    private var pendingDeskFetches: [String: (LocalProxyAsset) -> Void] = [:]
    private var deskFetchSeq: UInt64 = 0
    private var pendingScanCallbackId: String?
    private var started = false

    override init() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        // 保持持久数据存储（IndexedDB / Cache API / localStorage），不受 iOS Safari 7 天清理影响
        config.websiteDataStore = .default()

        let ucc = WKUserContentController()
        let bootstrapScript = WKUserScript(
            source: Self.nativeBridgeBootstrapJS,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        ucc.addUserScript(bootstrapScript)
        config.userContentController = ucc

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.scrollView.bounces = false
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.isOpaque = false
        wv.backgroundColor = .systemBackground
        #if DEBUG
        if #available(iOS 16.4, *) {
            wv.isInspectable = true
        }
        #endif
        self.webView = wv
        super.init()

        bridgeHandler.target = self
        ucc.add(bridgeHandler, name: "ensoNative")

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        server?.stop()
    }

    func startIfNeeded() {
        guard !started else { return }
        started = true

        guard let webRoot = Bundle.main.url(forResource: "WebApp", withExtension: nil) else {
            startupError = "缺少内嵌 WebApp 资源，请先运行 packages/ios-app/scripts/sync-web.sh 构建前端。"
            return
        }
        let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("EnsoDeskCache", isDirectory: true)

        let localServer = LocalWebServer(webRoot: webRoot, cacheRoot: cachesDir)
        localServer.deskAssetFetcher = { [weak self] tunnelPath, completion in
            Task { @MainActor [weak self] in
                self?.requestDeskAssetFromWebView(path: tunnelPath, completion: completion)
            }
        }
        do {
            _ = try localServer.start()
            self.server = localServer
            webView.load(URLRequest(url: localServer.baseURL))
        } catch {
            startupError = "启动本地 Web 容器失败：\(error.localizedDescription)"
        }
    }

    /// 支持 Universal Link / `enso://` 深链直达配对
    func handleIncomingURL(_ url: URL) {
        guard let base = server?.baseURL else { return }
        if url.scheme == "enso" || url.fragment?.contains("pk=") == true {
            var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)
            comps?.fragment = url.fragment ?? url.query
            if let target = comps?.url {
                webView.load(URLRequest(url: target))
            }
        }
    }

    func completeQrScan(with payload: String?) {
        isShowingScanner = false
        guard let cbId = pendingScanCallbackId else { return }
        pendingScanCallbackId = nil
        if let payload, let encoded = Self.jsStringLiteral(payload) {
            evalJS("window.__ensoNativeInternal?.resolveScan(\(Self.jsStringLiteral(cbId) ?? "\"\""), \(encoded));")
        } else {
            evalJS("window.__ensoNativeInternal?.resolveScan(\(Self.jsStringLiteral(cbId) ?? "\"\""), null);")
        }
    }

    @objc private func appDidBecomeActive() {
        // 切回前台时立即通知前端触发原生 QUIC / WebRTC 探活与重连
        evalJS("window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));")
    }

    @objc private func appDidEnterBackground() {
        evalJS("window.dispatchEvent(new Event('pagehide'));")
    }

    private func requestDeskAssetFromWebView(path: String, completion: @escaping (LocalProxyAsset) -> Void) {
        deskFetchSeq += 1
        let reqId = "d-\(deskFetchSeq)"
        pendingDeskFetches[reqId] = completion

        // 25s 超时保护，防止代理挂死
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
            if let pending = self?.pendingDeskFetches.removeValue(forKey: reqId) {
                pending(LocalProxyAsset(status: 504, mime: "text/plain", body: Data("desk fetch timeout".utf8)))
            }
        }

        guard let idLit = Self.jsStringLiteral(reqId),
              let pathLit = Self.jsStringLiteral(path)
        else {
            pendingDeskFetches.removeValue(forKey: reqId)?(
                LocalProxyAsset(status: 400, mime: "text/plain", body: Data())
            )
            return
        }
        evalJS("if (typeof window.__ensoDeskNativeFetch === 'function') { window.__ensoDeskNativeFetch(\(idLit), \(pathLit)); } else { window.__ensoNative?.replyDeskAsset(\(idLit), 503, 'text/plain', ''); }")
    }

    private func evalJS(_ script: String) {
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private static func jsStringLiteral(_ value: String) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: [value], options: []),
              let arr = String(data: data, encoding: .utf8),
              arr.count >= 2
        else { return nil }
        return String(arr.dropFirst().dropLast())
    }

    /// 在文档加载前注入 `window.__ensoNative`，与 `packages/phone/src/nativeBridge.ts` 协议严格对齐。
    private static let nativeBridgeBootstrapJS: String = """
    (() => {
      if (window.__ensoNative) return;
      const post = (msg) => window.webkit?.messageHandlers?.ensoNative?.postMessage(msg);
      let openCb = null, controlCb = null, binaryCb = null, closeCb = null;
      const scanResolvers = new Map();
      let scanSeq = 0;

      window.__ensoNativeInternal = {
        onOpen: (id) => { try { openCb && openCb(id); } catch {} },
        onControl: (id, text) => { try { controlCb && controlCb(id, text); } catch {} },
        onBinary: (id, b64) => { try { binaryCb && binaryCb(id, b64); } catch {} },
        onClose: (id, code, reason) => { try { closeCb && closeCb(id, code, reason); } catch {} },
        resolveScan: (cbId, value) => {
          const fn = scanResolvers.get(cbId);
          scanResolvers.delete(cbId);
          if (fn) fn(value);
        },
      };

      window.__ensoNative = {
        platform: 'ios',
        quic: true,
        deskProxy: true,
        openQuic: (params) => post({ type: 'quic-open', params }),
        sendQuicText: (id, text) => post({ type: 'quic-send-text', id, text }),
        sendQuicBinary: (id, lane, base64) => post({ type: 'quic-send-binary', id, lane, base64 }),
        closeQuic: (id, code, reason) => post({ type: 'quic-close', id, code: code ?? 1000, reason: reason ?? '' }),
        onQuicOpen: (cb) => { openCb = cb; },
        onQuicControl: (cb) => { controlCb = cb; },
        onQuicBinary: (cb) => { binaryCb = cb; },
        onQuicClose: (cb) => { closeCb = cb; },
        scanQr: () => new Promise((resolve) => {
          const cbId = 's-' + (++scanSeq);
          scanResolvers.set(cbId, resolve);
          post({ type: 'scan-qr', cbId });
        }),
        replyDeskAsset: (reqId, status, mime, bodyBase64) => post({
          type: 'desk-asset-reply',
          reqId,
          status,
          mime,
          bodyBase64,
        }),
      };
    })();
    """
}

extension EnsoWebShellController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String
        else { return }

        switch type {
        case "quic-open":
            guard let params = body["params"] as? [String: Any],
                  let id = params["id"] as? String,
                  let host = params["host"] as? String,
                  let portNum = params["port"] as? Int,
                  let port = UInt16(exactly: portNum),
                  let pairId = params["pairId"] as? String,
                  let role = params["role"] as? String,
                  let token = params["token"] as? String
            else { return }
            let alpn = (params["alpn"] as? String) ?? QuicFrameCodec.alpn
            let relayEpoch = params["relayEpoch"] as? String
            let sinceRelaySeq = (params["sinceRelaySeq"] as? NSNumber)?.uint64Value
            let hello = EnsoQuicHello(
                pairId: pairId,
                role: role,
                token: token,
                relayEpoch: relayEpoch,
                sinceRelaySeq: sinceRelaySeq
            )
            let cfg = EnsoQuicConfig(
                id: id,
                host: host,
                port: port,
                alpn: alpn,
                hello: hello,
                allowInsecureSelfSigned: false
            )
            let conn = QuicRelayConnection(config: cfg, delegate: self)
            quicConnections[id]?.close()
            quicConnections[id] = conn
            conn.start()

        case "quic-send-text":
            guard let id = body["id"] as? String,
                  let text = body["text"] as? String
            else { return }
            quicConnections[id]?.sendControlText(text)

        case "quic-send-binary":
            guard let id = body["id"] as? String,
                  let laneStr = body["lane"] as? String,
                  let b64 = body["base64"] as? String,
                  let data = Data(base64Encoded: b64)
            else { return }
            let lane: EnsoQuicLane = laneStr == "bulk" ? .bulk : .ctrl
            quicConnections[id]?.sendBinary(data, lane: lane)

        case "quic-close":
            guard let id = body["id"] as? String else { return }
            let code = (body["code"] as? Int) ?? 1000
            let reason = (body["reason"] as? String) ?? ""
            if let conn = quicConnections.removeValue(forKey: id) {
                conn.close(code: code, reason: reason)
            }

        case "scan-qr":
            guard let cbId = body["cbId"] as? String else { return }
            pendingScanCallbackId = cbId
            isShowingScanner = true

        case "desk-asset-reply":
            guard let reqId = body["reqId"] as? String,
                  let status = body["status"] as? Int,
                  let mime = body["mime"] as? String,
                  let b64 = body["bodyBase64"] as? String
            else { return }
            let data = Data(base64Encoded: b64) ?? Data()
            pendingDeskFetches.removeValue(forKey: reqId)?(
                LocalProxyAsset(status: status, mime: mime, body: data)
            )

        default:
            break
        }
    }
}

extension EnsoWebShellController: QuicRelayConnectionDelegate {
    nonisolated func quicConnectionDidOpen(_ id: String) {
        Task { @MainActor [weak self] in
            guard let self, let idLit = Self.jsStringLiteral(id) else { return }
            self.evalJS("window.__ensoNativeInternal?.onOpen(\(idLit));")
        }
    }

    nonisolated func quicConnection(_ id: String, didReceiveControlText text: String) {
        Task { @MainActor [weak self] in
            guard let self,
                  let idLit = Self.jsStringLiteral(id),
                  let textLit = Self.jsStringLiteral(text)
            else { return }
            self.evalJS("window.__ensoNativeInternal?.onControl(\(idLit), \(textLit));")
        }
    }

    nonisolated func quicConnection(_ id: String, didReceiveBinaryFrame data: Data, lane: EnsoQuicLane) {
        let b64 = data.base64EncodedString()
        Task { @MainActor [weak self] in
            guard let self,
                  let idLit = Self.jsStringLiteral(id),
                  let b64Lit = Self.jsStringLiteral(b64)
            else { return }
            self.evalJS("window.__ensoNativeInternal?.onBinary(\(idLit), \(b64Lit));")
        }
    }

    nonisolated func quicConnection(_ id: String, didCloseWithCode code: Int, reason: String) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.quicConnections.removeValue(forKey: id)
            guard let idLit = Self.jsStringLiteral(id),
                  let reasonLit = Self.jsStringLiteral(reason)
            else { return }
            self.evalJS("window.__ensoNativeInternal?.onClose(\(idLit), \(code), \(reasonLit));")
        }
    }
}

private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
