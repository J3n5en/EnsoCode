import CryptoKit
import Foundation
import Network

public struct LocalProxyAsset: Sendable {
    public let status: Int
    public let mime: String
    public let body: Data

    public init(status: Int, mime: String, body: Data) {
        self.status = status
        self.mime = mime
        self.body = body
    }
}

/// 仅绑定 127.0.0.1 的本机嵌入式 HTTP 服务：
/// 1. 托管打包进 iOS App Bundle 的 `packages/phone/dist` 静态文件（毫秒级冷启、零网络开销，
///    且赋予 WKWebView `http://127.0.0.1:<port>` 安全上下文，WebCrypto/Cache API/IndexedDB 全可用）；
/// 2. 将 `/desk/<pairId>/<version>/*` 与 `/desk/li/<pairId>/*` 请求缓存于本地磁盘，
///    未命中时通过回调向 JS 加密隧道拉取（在 WKWebView 缺少 Service Worker 时完整跑通 Desk 完整版）。
@available(iOS 16.0, macOS 13.0, *)
public final class LocalWebServer: @unchecked Sendable {
    public typealias DeskAssetFetcher = (_ deskPath: String, _ completion: @escaping (LocalProxyAsset) -> Void) -> Void

    private let webRoot: URL
    private let cacheRoot: URL
    private let queue = DispatchQueue(label: "com.ensocode.localweb")
    private let stateLock = NSLock()
    private var listener: NWListener?
    private var cancelGroup: DispatchGroup?
    private var assignedPort: UInt16 = 0
    private var running = false
    public var deskAssetFetcher: DeskAssetFetcher?

    public var port: UInt16 { assignedPort }
    public var baseURL: URL { URL(string: "http://127.0.0.1:\(assignedPort)/")! }
    public var isRunning: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return running
    }

    public init(webRoot: URL, cacheRoot: URL) {
        self.webRoot = webRoot
        self.cacheRoot = cacheRoot
        try? FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
    }

    public func start(preferredPort: UInt16 = 0) throws -> UInt16 {
        do {
            return try bind(port: preferredPort)
        } catch {
            if preferredPort != 0 {
                return try bind(port: 0)
            }
            throw error
        }
    }

    /// iOS 长时间挂起后台后系统可能回收 NWListener 套接字；切回前台调用此方法确保原端口恢复监听。
    @discardableResult
    public func ensureRunning() throws -> UInt16 {
        if isRunning { return assignedPort }
        let targetPort = assignedPort
        stop()
        return try start(preferredPort: targetPort)
    }

    private func bind(port preferredPort: UInt16) throws -> UInt16 {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: .ipv4(.loopback),
            port: preferredPort == 0 ? .any : NWEndpoint.Port(rawValue: preferredPort)!
        )
        let listener = try NWListener(using: params)
        self.listener = listener

        let ready = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        group.enter()
        var leftGroup = false
        self.cancelGroup = group
        var signaled = false
        var startError: Error?

        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.stateLock.lock()
                self.assignedPort = listener.port?.rawValue ?? 0
                self.running = true
                let shouldSignal = !signaled
                signaled = true
                self.stateLock.unlock()
                if shouldSignal { ready.signal() }
            case .failed(let err):
                self.stateLock.lock()
                self.running = false
                let shouldSignal = !signaled
                signaled = true
                if shouldSignal { startError = err }
                self.stateLock.unlock()
                if shouldSignal { ready.signal() }
            case .cancelled:
                self.stateLock.lock()
                self.running = false
                let shouldLeave = !leftGroup
                leftGroup = true
                self.stateLock.unlock()
                if shouldLeave { group.leave() }
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in
            self?.handleConnection(conn)
        }
        listener.start(queue: queue)
        ready.wait()
        if let startError {
            listener.cancel()
            self.listener = nil
            throw startError
        }
        return assignedPort
    }

    public func stop() {
        stateLock.lock()
        running = false
        let current = listener
        let group = cancelGroup
        listener = nil
        cancelGroup = nil
        stateLock.unlock()
        current?.cancel()
        _ = group?.wait(timeout: .now() + .milliseconds(300))
    }

    private func handleConnection(_ conn: NWConnection) {
        conn.start(queue: queue)
        readRequest(from: conn, buffer: Data())
    }

    private func readRequest(from conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if error != nil {
                conn.cancel()
                return
            }
            var next = buffer
            if let data { next.append(data) }
            if let headerRange = next.range(of: Data("\r\n\r\n".utf8)) {
                let headerData = next.subdata(in: 0..<headerRange.lowerBound)
                self.routeRequest(headerData: headerData, on: conn)
                return
            }
            if isComplete || next.count > 65536 {
                conn.cancel()
                return
            }
            self.readRequest(from: conn, buffer: next)
        }
    }

    private func routeRequest(headerData: Data, on conn: NWConnection) {
        guard let headerText = String(data: headerData, encoding: .utf8),
              let firstLine = headerText.split(separator: "\r\n", maxSplits: 1).first
        else {
            sendResponse(status: 400, mime: "text/plain", body: Data("bad request".utf8), on: conn)
            return
        }
        let parts = firstLine.split(separator: " ")
        guard parts.count >= 2 else {
            sendResponse(status: 400, mime: "text/plain", body: Data("bad request".utf8), on: conn)
            return
        }
        let method = String(parts[0])
        let rawTarget = String(parts[1])
        let pathOnly = rawTarget.split(separator: "?", maxSplits: 1).first.map(String.init) ?? "/"

        if method != "GET" && method != "HEAD" {
            sendResponse(status: 405, mime: "text/plain", body: Data("method not allowed".utf8), on: conn)
            return
        }

        // 1. 拦截 /desk/li/<pairId>/<encoded> 与 /desk/r/<pairId>/<version>/<rest>（保留原始百分号编码以对齐 sw.js）
        if let deskTunnelPath = Self.extractDeskTunnelPath(from: pathOnly) {
            handleDeskProxy(
                rawPath: pathOnly,
                tunnelPath: deskTunnelPath,
                headOnly: method == "HEAD",
                on: conn
            )
            return
        }

        // 2. 其余路径直接读 App Bundle 内的 phone dist 静态文件
        let decodedPath = pathOnly.removingPercentEncoding ?? pathOnly
        serveStatic(path: decodedPath, headOnly: method == "HEAD", on: conn)
    }

    /// 把浏览器请求的 `/desk/...` URL 转换为与 `packages/phone/public/sw.js` 完全一致的隧道资源路径：
    /// - `/desk/li/<pairId>/<rest>` -> `li/<rest>`
    /// - `/desk/r/<pairId>/<version>/<rest>` -> `r/<rest>`（保留 index.html 回退）
    /// - `/desk` 或 `/desk.html` 本身属于壳页，返回 nil 走静态文件。
    public static func extractDeskTunnelPath(from path: String) -> String? {
        let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
        guard trimmed.hasPrefix("desk/") else { return nil }
        let sub = String(trimmed.dropFirst("desk/".count))
        if sub.hasPrefix("li/") {
            let parts = sub.split(separator: "/", maxSplits: 2, omittingEmptySubsequences: false)
            guard parts.count == 3, !parts[1].isEmpty, !parts[2].isEmpty else { return nil }
            return "li/\(parts[2])"
        }
        if sub.hasPrefix("r/") {
            let parts = sub.split(separator: "/", maxSplits: 3, omittingEmptySubsequences: false)
            guard parts.count == 4, !parts[1].isEmpty, !parts[2].isEmpty else { return nil }
            let rest = parts[3].isEmpty ? "index.html" : String(parts[3])
            return "r/\(rest)"
        }
        return nil
    }

    private func handleDeskProxy(rawPath: String, tunnelPath: String, headOnly: Bool, on conn: NWConnection) {
        // 安全校验：禁止目录穿越
        let decoded = rawPath.removingPercentEncoding ?? rawPath
        guard !rawPath.contains(".."), !decoded.contains("..") else {
            sendResponse(status: 400, mime: "text/plain", body: Data("invalid path".utf8), on: conn)
            return
        }
        let cacheFile = cacheURL(for: rawPath)
        let metaFile = cacheFile.appendingPathExtension("mime")
        if let cachedData = try? Data(contentsOf: cacheFile),
           let cachedMime = try? String(contentsOf: metaFile, encoding: .utf8)
        {
            sendResponse(
                status: 200,
                mime: cachedMime.trimmingCharacters(in: .whitespacesAndNewlines),
                body: headOnly ? Data() : cachedData,
                contentLengthOverride: cachedData.count,
                cacheControl: "public, max-age=31536000, immutable",
                on: conn
            )
            return
        }

        guard let fetcher = deskAssetFetcher else {
            sendResponse(status: 503, mime: "text/plain", body: Data("desk tunnel not ready".utf8), on: conn)
            return
        }
        fetcher(tunnelPath) { [weak self] asset in
            guard let self else { return }
            if asset.status == 200 && !asset.body.isEmpty {
                self.saveCache(data: asset.body, mime: asset.mime, dataURL: cacheFile, metaURL: metaFile)
            }
            self.sendResponse(
                status: asset.status,
                mime: asset.mime,
                body: headOnly ? Data() : asset.body,
                contentLengthOverride: asset.body.count,
                cacheControl: asset.status == 200 ? "public, max-age=31536000, immutable" : "no-store",
                on: conn
            )
        }
    }

    private func cacheURL(for rawPath: String) -> URL {
        let digest = SHA256.hash(data: Data(rawPath.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return cacheRoot.appendingPathComponent(hex)
    }

    private func saveCache(data: Data, mime: String, dataURL: URL, metaURL: URL) {
        try? data.write(to: dataURL, options: .atomic)
        try? mime.data(using: .utf8)?.write(to: metaURL, options: .atomic)
    }

    private func serveStatic(path: String, headOnly: Bool, on conn: NWConnection) {
        var rel = path.hasPrefix("/") ? String(path.dropFirst()) : path
        if rel.isEmpty { rel = "index.html" }
        if rel.contains("..") {
            sendResponse(status: 400, mime: "text/plain", body: Data("bad path".utf8), on: conn)
            return
        }
        var candidate = webRoot.appendingPathComponent(rel)
        let fm = FileManager.default
        if !fm.fileExists(atPath: candidate.path) {
            if !rel.contains(".") {
                let htmlCandidate = webRoot.appendingPathComponent("\(rel).html")
                if fm.fileExists(atPath: htmlCandidate.path) {
                    candidate = htmlCandidate
                } else {
                    candidate = webRoot.appendingPathComponent("index.html")
                }
            } else {
                sendResponse(status: 404, mime: "text/plain", body: Data("not found".utf8), on: conn)
                return
            }
        }
        guard let data = try? Data(contentsOf: candidate) else {
            sendResponse(status: 404, mime: "text/plain", body: Data("not found".utf8), on: conn)
            return
        }
        let mime = Self.mimeType(for: candidate.pathExtension)
        let cc = rel.hasPrefix("assets/") ? "public, max-age=31536000, immutable" : "no-cache"
        sendResponse(
            status: 200,
            mime: mime,
            body: headOnly ? Data() : data,
            contentLengthOverride: data.count,
            cacheControl: cc,
            on: conn
        )
    }

    private func sendResponse(
        status: Int,
        mime: String,
        body: Data,
        contentLengthOverride: Int? = nil,
        cacheControl: String = "no-cache",
        on conn: NWConnection
    ) {
        let reason: String
        switch status {
        case 200: reason = "OK"
        case 400: reason = "Bad Request"
        case 404: reason = "Not Found"
        case 405: reason = "Method Not Allowed"
        case 502: reason = "Bad Gateway"
        case 503: reason = "Service Unavailable"
        default: reason = "Error"
        }
        let contentLength = contentLengthOverride ?? body.count
        let header =
            "HTTP/1.1 \(status) \(reason)\r\n" +
            "Content-Type: \(mime)\r\n" +
            "Content-Length: \(contentLength)\r\n" +
            "Cache-Control: \(cacheControl)\r\n" +
            "Connection: close\r\n\r\n"
        var out = Data(header.utf8)
        out.append(body)
        conn.send(content: out, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    public static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "woff2": return "font/woff2"
        case "wasm": return "application/wasm"
        default: return "application/octet-stream"
        }
    }
}
