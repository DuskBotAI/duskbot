import Capacitor
import Foundation

/// Native HTTP streaming client for iOS (`DuskStream`), matching Android's `SseStreamPlugin.java`.
///
/// WKWebView `fetch` (`CapacitorWebFetch`) attaches the page's `Origin` header, which triggers CORS
/// preflights and fails against companions whenever the app loads from a dev server URL instead of
/// `capacitor://localhost`. `URLSession` streams SSE (`/api/events`) and relay NDJSON incrementally
/// with no browser `Origin` header.
@objc(SseStreamPlugin)
public class SseStreamPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SseStreamPlugin"
    public let jsName = "DuskStream"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    ]

    private final class StreamEntry {
        let id: String
        let call: CAPPluginCall
        let wantStream: Bool
        let followRedirects: Bool
        var resolved = false
        var streaming = false
        var closedByClient = false
        var status = 0
        var resHeaders: [String: String] = [:]
        var buffer = Data()

        init(id: String, call: CAPPluginCall, wantStream: Bool, followRedirects: Bool) {
            self.id = id
            self.call = call
            self.wantStream = wantStream
            self.followRedirects = followRedirects
        }
    }

    private final class SessionDelegate: NSObject, URLSessionDataDelegate {
        weak var owner: SseStreamPlugin?

        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            guard let owner, let entry = owner.entriesByTask[task.taskIdentifier] else {
                completionHandler(nil)
                return
            }
            completionHandler(entry.followRedirects ? request : nil)
        }

        func urlSession(
            _ session: URLSession,
            dataTask: URLSessionDataTask,
            didReceive response: URLResponse,
            completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
        ) {
            guard let owner, let entry = owner.entriesByTask[dataTask.taskIdentifier] else {
                completionHandler(.cancel)
                return
            }
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 200
            var resHeaders: [String: String] = [:]
            var contentType = ""
            if let allHeaders = http?.allHeaderFields {
                for (rawKey, rawVal) in allHeaders {
                    guard let key = rawKey as? String else { continue }
                    let lower = key.lowercased()
                    if lower == "content-encoding" || lower == "transfer-encoding" || lower == "content-length" {
                        continue
                    }
                    let val = "\(rawVal)"
                    resHeaders[lower] = val
                    if lower == "content-type" { contentType = val.lowercased() }
                }
            }
            entry.status = status
            entry.resHeaders = resHeaders

            let isStream = status >= 200 && status < 300
                && (entry.wantStream || contentType.contains("text/event-stream") || contentType.contains("application/x-ndjson"))
            if isStream {
                entry.streaming = true
                entry.resolved = true
                entry.call.resolve(["status": status, "headers": resHeaders])
            }
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            guard let owner, let entry = owner.entriesByTask[dataTask.taskIdentifier], !data.isEmpty else { return }
            if entry.streaming {
                owner.notifyListeners("chunk", data: [
                    "id": entry.id,
                    "data": data.base64EncodedString(),
                ])
            } else {
                entry.buffer.append(data)
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            guard let owner, let entry = owner.entriesByTask.removeValue(forKey: task.taskIdentifier) else { return }
            owner.tasksById.removeValue(forKey: entry.id)

            if !entry.resolved {
                entry.resolved = true
                if let error {
                    entry.call.reject(error.localizedDescription)
                } else {
                    entry.call.resolve([
                        "status": entry.status,
                        "headers": entry.resHeaders,
                        "body": entry.buffer.base64EncodedString(),
                    ])
                }
                return
            }

            guard entry.streaming, !entry.closedByClient else { return }
            if let error {
                owner.notifyListeners("end", data: ["id": entry.id, "error": error.localizedDescription])
            } else {
                owner.notifyListeners("end", data: ["id": entry.id])
            }
        }
    }

    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.name = "bot.dusk.mobile.sse-stream"
        return q
    }()
    private let delegate = SessionDelegate()
    private lazy var session: URLSession = {
        delegate.owner = self
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = 60 * 60 * 24
        config.timeoutIntervalForResource = 60 * 60 * 24 * 7
        return URLSession(configuration: config, delegate: delegate, delegateQueue: queue)
    }()

    // Accessed exclusively on `queue`.
    private var entriesByTask: [Int: StreamEntry] = [:]
    private var tasksById: [String: URLSessionDataTask] = [:]

    deinit {
        session.invalidateAndCancel()
    }

    private static func isStreamingUrl(_ url: URL) -> Bool {
        let path = url.path.lowercased()
        if path.hasSuffix("/api/events") || path.hasSuffix("/stream") { return true }
        if let query = url.query {
            for part in query.split(separator: "&") where part == "stream=1" { return true }
        }
        return false
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty,
              let urlString = call.getString("url"), !urlString.isEmpty,
              let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            call.reject("id and a valid http(s) url are required")
            return
        }

        let method = (call.getString("method") ?? "GET").uppercased()
        let headers = call.getObject("headers") ?? [:]
        let bodyBase64 = call.getString("body")
        let connectTimeoutMs = call.getInt("connectTimeout") ?? 8_000
        let reqStream = call.getBool("stream") ?? false
        let followRedirects = call.getBool("followRedirects") ?? false

        var wantStream = reqStream || Self.isStreamingUrl(url)
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        request.httpMethod = method
        request.httpShouldHandleCookies = false

        for (rawKey, rawVal) in headers {
            let lower = rawKey.lowercased()
            if lower == "origin" || lower == "accept-encoding" { continue }
            guard let val = rawVal as? String else { continue }
            if lower == "accept" {
                let lowerVal = val.lowercased()
                if lowerVal.contains("text/event-stream") || lowerVal.contains("application/x-ndjson") {
                    wantStream = true
                }
            }
            request.setValue(val, forHTTPHeaderField: rawKey)
        }

        request.timeoutInterval = wantStream ? 60 * 60 * 24 : max(TimeInterval(connectTimeoutMs) / 1000.0 + 4.0, 15.0)

        if let bodyBase64, !bodyBase64.isEmpty, method != "GET", method != "HEAD",
           let payload = Data(base64Encoded: bodyBase64) {
            request.httpBody = payload
        }

        queue.addOperation { [weak self] in
            guard let self else { call.reject("plugin deallocated"); return }
            let task = self.session.dataTask(with: request)
            let entry = StreamEntry(id: id, call: call, wantStream: wantStream, followRedirects: followRedirects)
            self.entriesByTask[task.taskIdentifier] = entry
            self.tasksById[id] = task
            task.resume()
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else { call.resolve(); return }
        queue.addOperation { [weak self] in
            guard let self, let task = self.tasksById.removeValue(forKey: id) else {
                call.resolve()
                return
            }
            if let entry = self.entriesByTask[task.taskIdentifier] {
                entry.closedByClient = true
            }
            task.cancel()
            call.resolve()
        }
    }
}
