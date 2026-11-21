import Capacitor
import UIKit
import WebKit

/// The system's own context menu for things drawn by the page (a message bubble, a chat row): on iOS 26 it lifts a
/// snapshot of the item out of the blurred screen and draws the menu in Liquid Glass. `configurationForMenuAtLocation`
/// must answer at once, so the page arms a candidate on touchstart (its frame, and its actions when it has them) and
/// this answers from that when the long press is recognised. An item armed without actions asks the page for them
/// through a deferred menu element. Chromium iOS does the same over WKWebView: the interaction lives on a container,
/// never on the web view itself.
@objc(NativeMenuPlugin)
public class NativeMenuPlugin: CAPPlugin, CAPBridgedPlugin, UIContextMenuInteractionDelegate {
    public let identifier = "NativeMenuPlugin"
    public let jsName = "DuskMenu"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "supported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "arm", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "disarm", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "resolve", returnType: CAPPluginReturnNone),
    ]

    private struct Item { let key: String; let title: String; let icon: String?; let danger: Bool; let disabled: Bool; let checked: Bool }
    private struct Reaction { let key: String; let title: String; let glyph: String; let selected: Bool }
    private struct Content { let items: [Item]; let reactions: [Reaction] }

    private final class Held {
        let id: String
        var rect: CGRect
        var previewRect: CGRect
        var point: CGPoint?
        var radii: [CGFloat]
        let at = Date()
        var image: UIImage?
        var content: Content?
        var opened = false
        init(id: String, rect: CGRect, previewRect: CGRect, point: CGPoint?, radii: [CGFloat]) {
            self.id = id
            self.rect = rect
            self.previewRect = previewRect
            self.point = point
            self.radii = radii
        }
    }

    private var armed: Held?
    private var active: Held?
    private var pending: [String: ([UIMenuElement]) -> Void] = [:]
    private var interaction: UIContextMenuInteraction?

    @objc func supported(_ call: CAPPluginCall) {
        if #available(iOS 26.0, *) { call.resolve(["supported": true]) } else { call.resolve(["supported": false]) }
    }

    @objc func arm(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let rect = Self.rect(call.getObject("rect")) else { return }
        let radii = (call.getArray("radii") as? [NSNumber])?.map { CGFloat($0.doubleValue) } ?? [18, 18, 18, 18]
        let point = Self.point(call.getObject("point"))
        let content = Self.content(call.getObject("content"))
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.install()
            if let active = self.active, active.id == id {
                if let content {
                    active.content = content
                    if let done = self.pending.removeValue(forKey: id) {
                        done(self.elements(content, id: id))
                    }
                }
                return
            }
            let previewRect = self.bridge?.webView.map { Self.previewRect(for: rect, point: point, in: $0) } ?? rect
            if let held = self.armed, held.id == id {
                if let content { held.content = content }
                if held.rect != rect || held.previewRect != previewRect {
                    held.rect = rect
                    held.previewRect = previewRect
                    held.point = point
                    held.image = nil
                    self.snapshot(held)
                }
                held.radii = radii
                return
            }
            let held = Held(id: id, rect: rect, previewRect: previewRect, point: point, radii: radii)
            held.content = content
            self.armed = held
            self.snapshot(held)
        }
    }

    @objc func disarm(_ call: CAPPluginCall) {
        let id = call.getString("id")
        DispatchQueue.main.async { [weak self] in
            if id == nil || self?.armed?.id == id { self?.armed = nil }
        }
    }

    @objc func resolve(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return }
        let content = Self.content(call.getObject("content")) ?? Content(items: [], reactions: [])
        DispatchQueue.main.async { [weak self] in
            guard let self, let done = self.pending.removeValue(forKey: id) else { return }
            done(self.elements(content, id: id))
        }
    }

    private func install() {
        guard let host = bridge?.nativeHost, interaction?.view !== host else { return }
        if let old = interaction { old.view?.removeInteraction(old) }
        let next = UIContextMenuInteraction(delegate: self)
        host.addInteraction(next)
        interaction = next
    }

    private func snapshot(_ held: Held) {
        guard let web = bridge?.webView else { return }
        let config = WKSnapshotConfiguration()
        config.rect = held.previewRect
        config.afterScreenUpdates = false
        web.takeSnapshot(with: config) { [weak held] image, _ in held?.image = image }
    }

    private func emit(_ data: [String: Any]) { notifyListeners("menu", data: data) }

    // MARK: UIContextMenuInteractionDelegate

    public func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        guard let held = armed, Date().timeIntervalSince(held.at) < 3, let web = bridge?.webView, let view = interaction.view else { return nil }
        guard held.rect.insetBy(dx: -4, dy: -4).contains(view.convert(location, to: web)) else { return nil }
        // a press on the app's own native controls (the glass header and composer) is theirs
        var hit = view.hitTest(location, with: nil)
        while let current = hit, current !== web, current !== view {
            if current is UIControl || current is UIVisualEffectView { return nil }
            hit = current.superview
        }
        armed = nil
        active = held
        return UIContextMenuConfiguration(identifier: held.id as NSString, previewProvider: nil) { [weak self] _ in
            self?.menu(for: held)
        }
    }

    public func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration,
                                       highlightPreviewForItemWithIdentifier identifier: any NSCopying) -> UITargetedPreview? {
        let targeted = preview(in: interaction)
        if let held = active, !held.opened {
            held.opened = true
            emit(["type": "open", "id": held.id])
        }
        return targeted
    }

    public func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration,
                                       dismissalPreviewForItemWithIdentifier identifier: any NSCopying) -> UITargetedPreview? {
        preview(in: interaction)
    }

    public func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration,
                                       animator: (any UIContextMenuInteractionAnimating)?) {
        guard let held = active, !held.opened else { return }
        held.opened = true
        emit(["type": "open", "id": held.id])
    }

    public func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration,
                                       animator: (any UIContextMenuInteractionAnimating)?) {
        guard let held = active else { return }
        let id = held.id
        let host = interaction.view
        let web = bridge?.webView
        let animated = animator != nil
        let finish = { [weak self] in
            guard let self else { return }
            if animated, let image = held.image, let host, let web, host.window != nil {
                let frame = web.convert(held.previewRect, to: host)
                let cover = UIImageView(image: image)
                cover.contentMode = .scaleAspectFill
                cover.clipsToBounds = true
                cover.isUserInteractionEnabled = false
                cover.frame = frame
                let mask = CAShapeLayer()
                mask.path = Self.roundedPath(cover.bounds, radii: held.radii).cgPath
                cover.layer.mask = mask
                host.addSubview(cover)
                // bridge the 1-2 frames between UIKit removing the dismissal preview and WebKit revealing the DOM node
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { cover.removeFromSuperview() }
            }
            if self.active?.id == id { self.active = nil }
            self.pending.removeValue(forKey: id)?([])
            self.emit(["type": "close", "id": id])
        }
        if let animator { animator.addCompletion(finish) } else { finish() }
    }

    /// the item's snapshot where it sits on screen, cut to its own corners. Previews must be in a window (crbug 1351669).
    private func preview(in interaction: UIContextMenuInteraction) -> UITargetedPreview? {
        guard let held = active, let web = bridge?.webView, let host = interaction.view, host.window != nil else { return nil }
        let frame = web.convert(held.previewRect, to: host)
        let shot: UIView
        if let image = held.image {
            let view = UIImageView(image: image)
            view.contentMode = .scaleAspectFill
            view.clipsToBounds = true
            shot = view
        } else if let view = web.resizableSnapshotView(from: held.previewRect, afterScreenUpdates: false, withCapInsets: .zero) {
            shot = view
        } else {
            return nil
        }
        shot.frame = CGRect(origin: .zero, size: frame.size)
        let parameters = UIPreviewParameters()
        parameters.backgroundColor = .clear
        parameters.visiblePath = Self.roundedPath(shot.bounds, radii: held.radii)
        return UITargetedPreview(view: shot, parameters: parameters, target: UIPreviewTarget(container: host, center: CGPoint(x: frame.midX, y: frame.midY)))
    }

    // MARK: menu

    private func menu(for held: Held) -> UIMenu {
        if let content = held.content { return UIMenu(children: elements(content, id: held.id)) }
        let id = held.id
        return UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] done in
            guard let self else { done([]); return }
            self.pending.removeValue(forKey: id)?([])
            self.pending[id] = done
            self.emit(["type": "request", "id": id])
        }])
    }

    private func elements(_ content: Content, id: String) -> [UIMenuElement] {
        var children: [UIMenuElement] = []
        if !content.reactions.isEmpty {
            let reactions = content.reactions.map { reaction in
                let action = UIAction(title: reaction.title, image: Self.glyph(reaction.glyph)) { [weak self] _ in
                    self?.emit(["type": "react", "id": id, "key": reaction.key])
                }
                action.accessibilityLabel = reaction.title
                action.state = reaction.selected ? .on : .off
                return action
            }
            children.append(UIMenu(title: "", options: [.displayInline, .displayAsPalette], children: reactions))
        }
        let actions: [UIMenuElement] = content.items.map { item in
            let action = UIAction(title: item.title, image: item.icon.flatMap { UIImage(systemName: $0) }) { [weak self] _ in
                self?.emit(["type": "select", "id": id, "key": item.key])
            }
            if item.danger { action.attributes.insert(.destructive) }
            if item.disabled { action.attributes.insert(.disabled) }
            if item.checked { action.state = .on }
            return action
        }
        if !actions.isEmpty { children.append(UIMenu(title: "", options: .displayInline, children: actions)) }
        return children
    }

    // MARK: parsing and drawing

    private static func rect(_ value: JSObject?) -> CGRect? {
        guard let value, let x = (value["x"] as? NSNumber)?.doubleValue, let y = (value["y"] as? NSNumber)?.doubleValue,
              let w = (value["w"] as? NSNumber)?.doubleValue, let h = (value["h"] as? NSNumber)?.doubleValue, w > 0, h > 0 else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }

    private static func point(_ value: JSObject?) -> CGPoint? {
        guard let value, let x = (value["x"] as? NSNumber)?.doubleValue, let y = (value["y"] as? NSNumber)?.doubleValue else { return nil }
        return CGPoint(x: x, y: y)
    }

    private static func previewRect(for rect: CGRect, point: CGPoint?, in web: WKWebView) -> CGRect {
        let insets = web.safeAreaInsets
        let visible = web.bounds.inset(by: UIEdgeInsets(top: insets.top, left: 0, bottom: insets.bottom, right: 0))
        let clipped = rect.intersection(visible)
        let base = clipped.isNull || clipped.width < 1 || clipped.height < 1 ? rect.intersection(web.bounds) : clipped
        guard !base.isNull, base.width >= 1, base.height >= 1 else { return rect }
        let maxHeight = max(140, min(320, visible.height - 420))
        guard base.height > maxHeight else { return base }
        let anchorY = point?.y ?? base.midY
        let top = min(max(base.minY, anchorY - maxHeight / 2), base.maxY - maxHeight)
        return CGRect(x: base.minX, y: top, width: base.width, height: maxHeight)
    }

    private static func content(_ value: JSObject?) -> Content? {
        guard let value else { return nil }
        let items = (value["items"] as? [JSObject] ?? []).compactMap { d -> Item? in
            guard let key = d["key"] as? String, let title = d["title"] as? String else { return nil }
            return Item(key: key, title: title, icon: d["icon"] as? String, danger: d["danger"] as? Bool ?? false,
                        disabled: d["disabled"] as? Bool ?? false, checked: d["checked"] as? Bool ?? false)
        }
        let reactions = (value["reactions"] as? [JSObject] ?? []).compactMap { d -> Reaction? in
            guard let key = d["key"] as? String, let glyph = d["glyph"] as? String else { return nil }
            return Reaction(key: key, title: d["title"] as? String ?? key, glyph: glyph, selected: d["selected"] as? Bool ?? false)
        }
        return Content(items: items, reactions: reactions)
    }

    private static func glyph(_ text: String) -> UIImage {
        let size = CGSize(width: 32, height: 32)
        let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 26)]
        let measured = (text as NSString).size(withAttributes: attributes)
        return UIGraphicsImageRenderer(size: size).image { _ in
            (text as NSString).draw(at: CGPoint(x: (size.width - measured.width) / 2, y: (size.height - measured.height) / 2), withAttributes: attributes)
        }.withRenderingMode(.alwaysOriginal)
    }

    /// corners in css order: top left, top right, bottom right, bottom left
    static func roundedPath(_ r: CGRect, radii: [CGFloat]) -> UIBezierPath {
        let limit = min(r.width, r.height) / 2
        let c = (0..<4).map { min(max(0, $0 < radii.count ? radii[$0] : 0), limit) }
        let (tl, tr, br, bl) = (c[0], c[1], c[2], c[3])
        let path = UIBezierPath()
        path.move(to: CGPoint(x: r.minX + tl, y: r.minY))
        path.addLine(to: CGPoint(x: r.maxX - tr, y: r.minY))
        path.addArc(withCenter: CGPoint(x: r.maxX - tr, y: r.minY + tr), radius: tr, startAngle: -.pi / 2, endAngle: 0, clockwise: true)
        path.addLine(to: CGPoint(x: r.maxX, y: r.maxY - br))
        path.addArc(withCenter: CGPoint(x: r.maxX - br, y: r.maxY - br), radius: br, startAngle: 0, endAngle: .pi / 2, clockwise: true)
        path.addLine(to: CGPoint(x: r.minX + bl, y: r.maxY))
        path.addArc(withCenter: CGPoint(x: r.minX + bl, y: r.maxY - bl), radius: bl, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
        path.addLine(to: CGPoint(x: r.minX, y: r.minY + tl))
        path.addArc(withCenter: CGPoint(x: r.minX + tl, y: r.minY + tl), radius: tl, startAngle: .pi, endAngle: .pi * 1.5, clockwise: true)
        path.close()
        return path
    }
}
