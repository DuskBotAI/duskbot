import Capacitor
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Files the app hands the page: each written to its own folder in tmp and described by its file URL, name and type,
/// which the page reads back through the web view's file scheme.
enum PickedFiles {
    static func makeTempFolder() -> URL? {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("dusk-picks", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) } catch { return nil }
        return dir
    }

    static func describe(_ url: URL, type: String? = nil) -> [String: Any] {
        let mime = type ?? UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        return ["path": url.absoluteString, "name": url.lastPathComponent, "type": mime]
    }

    static func write(_ data: Data, name: String, type: String) -> [String: Any]? {
        guard let dir = makeTempFolder() else { return nil }
        let url = dir.appendingPathComponent(name)
        do { try data.write(to: url) } catch { return nil }
        return describe(url, type: type)
    }

    static func copy(_ source: URL) -> [String: Any]? {
        guard let dir = makeTempFolder() else { return nil }
        let url = dir.appendingPathComponent(source.lastPathComponent)
        do { try FileManager.default.copyItem(at: source, to: url) } catch { return nil }
        return describe(url)
    }

    /// A picture as the page can show it anywhere: PNG, GIF and JPEG stay as they are; HEIC and the rest become JPEG,
    /// as Safari's own file input does.
    static func image(_ image: UIImage, index: Int) -> [String: Any]? {
        guard let data = image.jpegData(compressionQuality: 0.9) else { return nil }
        return write(data, name: "image-\(index + 1).jpg", type: "image/jpeg")
    }

    static func load(results: [PHPickerResult], completion: @escaping ([[String: Any]]) -> Void) {
        guard !results.isEmpty else { completion([]); return }
        var files = [[String: Any]?](repeating: nil, count: results.count)
        let lock = NSLock()
        let put = { (index: Int, file: [String: Any]?) in lock.lock(); files[index] = file; lock.unlock() }
        let group = DispatchGroup()
        for (index, result) in results.enumerated() {
            let provider = result.itemProvider
            group.enter()
            let kept = [UTType.png, UTType.gif, UTType.jpeg, UTType.movie, UTType.mpeg4Movie, UTType.quickTimeMovie]
                .first { type in provider.registeredTypeIdentifiers.contains(type.identifier) }
            if let kept {
                provider.loadFileRepresentation(forTypeIdentifier: kept.identifier) { url, _ in
                    if let url { put(index, copy(url)) }
                    group.leave()
                }
            } else if provider.canLoadObject(ofClass: UIImage.self) {
                provider.loadObject(ofClass: UIImage.self) { object, _ in
                    if let uiImage = object as? UIImage { put(index, Self.image(uiImage, index: index)) }
                    group.leave()
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                provider.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { url, _ in
                    if let url { put(index, copy(url)) }
                    group.leave()
                }
            } else {
                group.leave()
            }
        }
        group.notify(queue: .main) { completion(files.compactMap { $0 }) }
    }

    /// The images on the pasteboard, PNG kept as PNG.
    static func pasteboardImages(_ board: UIPasteboard = .general) -> [[String: Any]] {
        var out: [[String: Any]] = []
        for (index, item) in board.items.enumerated() {
            if let png = item[UTType.png.identifier] as? Data, let file = write(png, name: "pasted-\(index + 1).png", type: "image/png") { out.append(file); continue }
            if let gif = item[UTType.gif.identifier] as? Data, let file = write(gif, name: "pasted-\(index + 1).gif", type: "image/gif") { out.append(file); continue }
            if let jpeg = item[UTType.jpeg.identifier] as? Data, let file = write(jpeg, name: "pasted-\(index + 1).jpg", type: "image/jpeg") { out.append(file); continue }
            let picture = item.values.lazy.compactMap { value -> UIImage? in
                if let image = value as? UIImage { return image }
                if let data = value as? Data { return UIImage(data: data) }
                return nil
            }.first
            if let picture, let data = picture.jpegData(compressionQuality: 0.9), let file = write(data, name: "pasted-\(index + 1).jpg", type: "image/jpeg") { out.append(file) }
        }
        return out
    }
}

/// A plain text field that also takes a pasted picture: UIKit offers Paste in a plain UITextView only for text, so a
/// copied photo could never reach the chat. The pictures go to `onPasteImages`; text pastes as before.
final class PastingTextView: UITextView {
    var onPasteImages: (([[String: Any]]) -> Void)?
    var onHardwareReturn: (() -> Void)?

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if let onHardwareReturn, markedTextRange == nil {
            let unconsumed = presses.filter { press in
                guard let key = press.key,
                      key.keyCode == .keyboardReturnOrEnter || key.keyCode == .keypadEnter,
                      key.modifierFlags.intersection([.shift, .alternate, .control, .command]).isEmpty else {
                    return true
                }
                onHardwareReturn()
                return false
            }
            if unconsumed.isEmpty { return }
            super.pressesBegan(unconsumed, with: event)
            return
        }
        super.pressesBegan(presses, with: event)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), onPasteImages != nil, UIPasteboard.general.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        let board = UIPasteboard.general
        if let onPasteImages, board.hasImages, !board.hasStrings {
            let files = PickedFiles.pasteboardImages(board)
            if !files.isEmpty { onPasteImages(files); return }
        }
        super.paste(sender)
    }
}

/// The composer's + choices: floating media picker sheet for Photo library and Camera, and the system document picker
/// for Files. A web file input on iOS always asks first (take a photo, the library or Files), even with `accept`.
@objc(PickerPlugin)
public class PickerPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "PickerPlugin"
    public let jsName = "DuskPicker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "photos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "files", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "camera", returnType: CAPPluginReturnPromise),
    ]

    private var pending: CAPPluginCall?

    private func begin(_ call: CAPPluginCall) {
        pending?.resolve(["files": []])
        pending = call
    }

    private func finish(_ files: [[String: Any]]) {
        pending?.resolve(["files": files])
        pending = nil
    }

    private func topPresenter() -> UIViewController? {
        guard var top = bridge?.viewController else { return nil }
        while let next = top.presentedViewController { top = next }
        return top
    }

    private func glassPlugin() -> GlassChromePlugin? {
        (bridge?.plugin(withName: "DuskGlass") ?? bridge?.plugin(withName: "GlassChromePlugin")) as? GlassChromePlugin
    }

    private func makeMorphContext(for presenter: UIViewController, sourceObject: JSObject?) -> MediaPickerMorphContext? {
        if let glass = glassPlugin(), let origin = glass.composerMorphOrigin(in: presenter.view) {
            glass.setComposerSuppressed(true)
            return MediaPickerMorphContext(
                origin: origin,
                resolveDismissRect: { [weak glass, weak presenter] in
                    guard let glass, let presenter else { return origin.restingRect }
                    return glass.currentComposerRect(in: presenter.view) ?? origin.restingRect
                },
                onRelease: { [weak glass] done in
                    glass?.setComposerSuppressed(false)
                    done()
                }
            )
        }
        guard let sourceObject,
              let webView = bridge?.webView,
              let x = (sourceObject["x"] as? NSNumber)?.doubleValue,
              let y = (sourceObject["y"] as? NSNumber)?.doubleValue,
              let w = (sourceObject["w"] as? NSNumber)?.doubleValue,
              let h = (sourceObject["h"] as? NSNumber)?.doubleValue,
              w >= 40, h >= 24 else {
            return nil
        }
        let rectInWeb = CGRect(x: x, y: y, width: w, height: h)
        let rectInPresenter = webView.convert(rectInWeb, to: presenter.view)
        let radius = CGFloat((sourceObject["radius"] as? NSNumber)?.doubleValue ?? min(24, h / 2))
        let snapshot = webView.resizableSnapshotView(from: rectInWeb, afterScreenUpdates: false, withCapInsets: .zero)
        let style = presenter.view.traitCollection.userInterfaceStyle
        let origin = ComposerMorphOrigin(
            rect: rectInPresenter,
            restingRect: rectInPresenter,
            cornerRadius: radius,
            userInterfaceStyle: style,
            snapshot: snapshot
        )
        let selector = "[data-mobile-chat] [data-tour=\"composer\"], [data-tour=\"composer\"]"
        webView.evaluateJavaScript("document.querySelector('\(selector)')?.style.setProperty('opacity','0')", completionHandler: nil)
        return MediaPickerMorphContext(
            origin: origin,
            resolveDismissRect: { origin.restingRect },
            onRelease: { [weak webView] done in
                guard let webView else { done(); return }
                webView.evaluateJavaScript("document.querySelector('\(selector)')?.style.removeProperty('opacity')") { _, _ in
                    done()
                }
            }
        )
    }

    private func presentMediaSheet(mode: MediaPickerSheetViewController.Mode, multiple: Bool, labels: MediaPickerLabels, source: JSObject?) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.topPresenter() else { self?.finish([]); return }
            let morph = self.makeMorphContext(for: presenter, sourceObject: source)
            presenter.view.window?.endEditing(true)
            let sheet = MediaPickerSheetViewController(mode: mode, multiple: multiple, labels: labels, morph: morph) { [weak self] files in
                self?.finish(files)
            }
            presenter.present(sheet, animated: false)
        }
    }

    @objc func photos(_ call: CAPPluginCall) {
        begin(call)
        let multiple = call.getBool("multiple") ?? true
        let labels = MediaPickerLabels(call.getObject("labels"))
        presentMediaSheet(mode: .photos, multiple: multiple, labels: labels, source: call.getObject("source"))
    }

    @objc func files(_ call: CAPPluginCall) {
        begin(call)
        let multiple = call.getBool("multiple") ?? true
        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.topPresenter() else { self?.finish([]); return }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
            picker.allowsMultipleSelection = multiple
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }

    @objc func camera(_ call: CAPPluginCall) {
        begin(call)
        let labels = MediaPickerLabels(call.getObject("labels"))
        presentMediaSheet(mode: .camera, multiple: true, labels: labels, source: call.getObject("source"))
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish(urls.compactMap { PickedFiles.copy($0) })
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish([])
    }
}
