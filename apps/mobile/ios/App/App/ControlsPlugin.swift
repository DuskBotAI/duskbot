import Capacitor
import UIKit
import WebKit

/// The system's own controls (a segmented control, a switch, a pop-up menu button) where the page leaves room for one.
/// The page gives the room's place inside its scrolling area; the control sits over the web view and follows that area's
/// scroll view, so it moves with the page under the finger and not a frame behind it.
@objc(ControlsPlugin)
public class ControlsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ControlsPlugin"
    public let jsName = "DuskControls"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "place", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "trigger", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise)
    ]

    /// Clips its control to the page's scrolling area and lets every touch outside the control through to the page.
    private final class Window: UIView {
        override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
            let hit = super.hitTest(point, with: event)
            return hit === self ? nil : hit
        }
    }

    private final class PopupButton: UIButton {
        var isMenuOpen = false
        var menuSignature = ""
        var naturalSize = CGSize(width: 44, height: 44)
        var onSelect: ((String) -> Void)?
        var pendingConfigure: (() -> Void)?

        override init(frame: CGRect) {
            super.init(frame: frame)
            showsMenuAsPrimaryAction = true
            preferredMenuElementOrder = .fixed
            contentHorizontalAlignment = .trailing
        }

        required init?(coder: NSCoder) { fatalError() }

        override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
            super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
            isMenuOpen = true
        }

        override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
            super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
            let finish: () -> Void = { [weak self] in
                guard let self else { return }
                self.isMenuOpen = false
                if let pending = self.pendingConfigure {
                    self.pendingConfigure = nil
                    pending()
                }
            }
            if let animator = animator { animator.addCompletion(finish) } else { finish() }
        }
    }

    private final class Placed {
        let window = Window()
        let control: UIControl
        var room = CGRect.zero
        var lastClip = CGRect.zero
        var inset: CGFloat = 0
        var scrollHeight: CGFloat = 0
        weak var scroller: UIScrollView?
        var watching: NSKeyValueObservation?

        init(control: UIControl) {
            self.control = control
            window.clipsToBounds = true
            window.addSubview(control)
        }

        func settle() {
            let offset = scroller?.contentOffset ?? .zero
            let rtl = control.effectiveUserInterfaceLayoutDirection == .rightToLeft
            let size: CGSize
            let x: CGFloat
            if control is UISwitch {
                size = control.intrinsicContentSize
                x = rtl ? room.minX : room.maxX - size.width
            } else if let popup = control as? PopupButton {
                let natural = popup.naturalSize
                let maxWidth = max(room.width + 16, window.bounds.width * 0.58)
                let width = max(44, min(natural.width, maxWidth))
                let height = max(natural.height, 44)
                size = CGSize(width: width, height: height)
                x = rtl ? room.minX : room.maxX - width
            } else {
                size = room.size
                x = room.minX
            }
            let frame = CGRect(x: x - offset.x, y: room.midY - size.height / 2 - offset.y - inset, width: size.width, height: size.height)
            if abs(control.frame.minX - frame.minX) > 0.1 || abs(control.frame.minY - frame.minY) > 0.1
                || abs(control.frame.width - frame.width) > 0.1 || abs(control.frame.height - frame.height) > 0.1 {
                control.frame = frame
            }
        }
    }

    private var placed: [String: Placed] = [:]

    @objc func place(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let kind = call.getString("kind"),
              let room = Self.rect(call.getObject("room")), let clip = Self.rect(call.getObject("clip")) else {
            call.reject("A control needs an id, a kind, a room and a clip.", "invalid")
            return
        }
        let items = (call.getArray("items") ?? []).compactMap { $0 as? String }
        let selected = call.getInt("selected") ?? 0
        let on = call.getBool("on") ?? false
        let title = call.getString("title") ?? ""
        let value = call.getString("value") ?? ""
        let options = (call.getArray("options") ?? []).compactMap { $0 as? [String: Any] }
        let disabled = call.getBool("disabled") ?? false
        let label = call.getString("label")
        let tint = call.getString("tint").flatMap { Self.colour(hex: $0) }
        let hidden = call.getBool("hidden") ?? false
        let alpha = CGFloat(min(1, max(0, call.getDouble("alpha") ?? 1)))
        let maskRight = call.getDouble("maskRight").map { CGFloat($0) }
        let scrollable = call.getBool("scrollable") ?? false
        let scrollTop = CGFloat(call.getDouble("scrollTop") ?? 0)
        let scrollHeight = CGFloat(call.getDouble("scrollHeight") ?? 0)
        let inset = CGFloat(call.getDouble("inset") ?? 0)
        DispatchQueue.main.async {
            guard let webView = self.webView else { call.resolve(["tracked": false]); return }
            let entry: Placed
            if let known = self.placed[id] {
                entry = known
            } else {
                entry = Placed(control: self.control(kind: kind, id: id, items: items))
                entry.window.alpha = alpha
                entry.window.isHidden = hidden
                self.placed[id] = entry
                webView.addSubview(entry.window)
            }
            if !entry.control.isTracking {
                if let segments = entry.control as? UISegmentedControl {
                    let titles = (0..<segments.numberOfSegments).map { segments.titleForSegment(at: $0) ?? "" }
                    if titles != items {
                        segments.removeAllSegments()
                        for (index, title) in items.enumerated() { segments.insertSegment(withTitle: title, at: index, animated: false) }
                    }
                    if segments.selectedSegmentIndex != selected { segments.selectedSegmentIndex = selected }
                } else if let toggle = entry.control as? UISwitch, toggle.isOn != on {
                    toggle.setOn(on, animated: true)
                } else if let popup = entry.control as? PopupButton {
                    let signature = Self.popupSignature(title: title, value: value, options: options)
                    if popup.menuSignature != signature {
                        let apply: () -> Void = { [weak self, weak entry, weak popup] in
                            guard let self, let entry, let popup else { return }
                            self.configure(popup: popup, title: title, value: value, options: options)
                            popup.menuSignature = signature
                            popup.accessibilityValue = title
                            entry.settle()
                        }
                        if popup.isMenuOpen {
                            popup.pendingConfigure = apply
                        } else {
                            popup.pendingConfigure = nil
                            apply()
                        }
                    } else {
                        popup.accessibilityValue = title
                    }
                }
            }
            if let toggle = entry.control as? UISwitch { toggle.onTintColor = tint }
            entry.control.isEnabled = !disabled
            entry.control.accessibilityLabel = label
            let rightEdge = maskRight.map { min(clip.maxX, $0) } ?? clip.maxX
            let windowFrame = CGRect(x: clip.minX, y: clip.minY + inset, width: max(0, rightEdge - clip.minX), height: max(0, clip.height - inset))
            let effectivelyHidden = hidden || windowFrame.width <= 0.5
            entry.window.isHidden = effectivelyHidden
            entry.window.alpha = alpha
            entry.window.isUserInteractionEnabled = !effectivelyHidden && alpha > 0.5 && maskRight == nil
            if abs(entry.window.frame.minX - windowFrame.minX) > 0.5 || abs(entry.window.frame.minY - windowFrame.minY) > 0.5
                || abs(entry.window.frame.width - windowFrame.width) > 0.5 || abs(entry.window.frame.height - windowFrame.height) > 0.5 {
                entry.window.frame = windowFrame
            }
            let clipChanged = abs(entry.lastClip.minX - clip.minX) > 0.5 || abs(entry.lastClip.minY - clip.minY) > 0.5
                || abs(entry.lastClip.width - clip.width) > 0.5 || abs(entry.lastClip.height - clip.height) > 0.5
            entry.lastClip = clip
            entry.room = room
            entry.inset = inset
            if !scrollable {
                entry.scroller = nil
                entry.watching = nil
                entry.scrollHeight = 0
            } else {
                let needsSearch = entry.scroller == nil || entry.scroller?.superview == nil || (clipChanged && maskRight == nil) || abs(entry.scrollHeight - scrollHeight) >= 3
                if needsSearch {
                    let scroller = self.scroller(in: webView, showing: clip, tall: scrollHeight, at: scrollTop)
                    if let scroller = scroller {
                        entry.scrollHeight = scrollHeight
                        if scroller !== entry.scroller {
                            entry.scroller = scroller
                            entry.watching = scroller.observe(\.contentOffset) { [weak entry] _, _ in entry?.settle() }
                        }
                    } else if entry.scroller?.superview == nil {
                        entry.scroller = nil
                        entry.watching = nil
                    }
                }
            }
            entry.settle()
            call.resolve(["tracked": !scrollable || entry.scroller != nil])
        }
    }

    @objc func trigger(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        DispatchQueue.main.async {
            guard #available(iOS 17.4, *),
                  let entry = self.placed[id],
                  let popup = entry.control as? PopupButton,
                  !entry.window.isHidden,
                  entry.window.alpha > 0.5,
                  popup.isEnabled,
                  !popup.isMenuOpen else {
                call.resolve(["triggered": false])
                return
            }
            popup.performPrimaryAction()
            call.resolve(["triggered": true])
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        DispatchQueue.main.async {
            if let entry = self.placed.removeValue(forKey: id) {
                entry.watching = nil
                entry.window.removeFromSuperview()
            }
            call.resolve()
        }
    }

    /// A page that has just loaded has left no rooms: the controls of the page before it go.
    @objc func reset(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            for entry in self.placed.values {
                entry.watching = nil
                entry.window.removeFromSuperview()
            }
            self.placed.removeAll()
            call.resolve()
        }
    }

    private func control(kind: String, id: String, items: [String]) -> UIControl {
        if kind == "switch" {
            let toggle = UISwitch()
            toggle.addAction(UIAction { [weak self, weak toggle] _ in
                self?.notifyListeners("change", data: ["id": id, "on": toggle?.isOn ?? false])
            }, for: .valueChanged)
            return toggle
        }
        if kind == "popup" {
            let popup = PopupButton(type: .system)
            popup.onSelect = { [weak self] key in
                self?.notifyListeners("change", data: ["id": id, "value": key])
            }
            return popup
        }
        let segments = UISegmentedControl(items: items)
        segments.addAction(UIAction { [weak self, weak segments] _ in
            self?.notifyListeners("change", data: ["id": id, "selected": segments?.selectedSegmentIndex ?? 0])
        }, for: .valueChanged)
        return segments
    }

    private func configure(popup: PopupButton, title: String, value: String, options: [[String: Any]]) {
        var config = UIButton.Configuration.plain()
        config.baseForegroundColor = .secondaryLabel
        config.contentInsets = .zero
        config.title = title
        config.titleLineBreakMode = .byTruncatingTail
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var out = incoming
            out.font = .systemFont(ofSize: 17, weight: .regular)
            return out
        }
        let symbolConfig = UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
        config.image = UIImage(systemName: "chevron.up.chevron.down", withConfiguration: symbolConfig)
        config.imagePlacement = .trailing
        config.imagePadding = 5
        popup.configuration = config
        popup.naturalSize = popup.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude))

        var groups: [[UIMenuElement]] = [[]]
        for item in options {
            guard let key = item["key"] as? String, let label = item["label"] as? String else { continue }
            if item["separated"] as? Bool == true, !(groups.last ?? []).isEmpty { groups.append([]) }
            var attributes: UIMenuElement.Attributes = []
            if item["danger"] as? Bool == true { attributes.insert(.destructive) }
            if item["disabled"] as? Bool == true { attributes.insert(.disabled) }
            let action = UIAction(title: label, attributes: attributes, state: key == value ? .on : .off) { [weak popup] _ in
                popup?.isMenuOpen = false
                popup?.onSelect?(key)
            }
            groups[groups.count - 1].append(action)
        }
        let children: [UIMenuElement] = groups.count == 1 ? groups[0] : groups.map { UIMenu(options: .displayInline, children: $0) }
        popup.menu = UIMenu(children: children)
    }

    private static func popupSignature(title: String, value: String, options: [[String: Any]]) -> String {
        var parts = [title, value]
        for item in options {
            let key = item["key"] as? String ?? ""
            let label = item["label"] as? String ?? ""
            let disabled = item["disabled"] as? Bool == true ? "1" : "0"
            let danger = item["danger"] as? Bool == true ? "1" : "0"
            let separated = item["separated"] as? Bool == true ? "1" : "0"
            parts.append("\(key)\u{1f}\(label)\u{1f}\(disabled)\(danger)\(separated)")
        }
        return parts.joined(separator: "\u{1e}")
    }

    /// WebKit scrolls an overflowing element in a scroll view of its own (iOS 13 and later). The one for the page's area
    /// shows the same part of the web view and holds content as tall; of several such (a page lying under a sheet has
    /// the same frame), it is the one scrolled nearest to where the page says its area is.
    private func scroller(in webView: WKWebView, showing clip: CGRect, tall: CGFloat, at scrollTop: CGFloat) -> UIScrollView? {
        var found: UIScrollView?
        func search(_ view: UIView) {
            for child in view.subviews {
                if let candidate = child as? UIScrollView, candidate !== webView.scrollView {
                    let shown = candidate.convert(candidate.bounds, to: webView)
                    if abs(shown.minX - clip.minX) < 3, abs(shown.minY - clip.minY) < 3, abs(shown.width - clip.width) < 3, abs(shown.height - clip.height) < 3,
                       abs(candidate.contentSize.height - tall) < 3,
                       abs(candidate.contentOffset.y - scrollTop) < abs((found?.contentOffset.y ?? .infinity) - scrollTop) {
                        found = candidate
                    }
                }
                search(child)
            }
        }
        search(webView)
        return found
    }

    private static func colour(hex: String) -> UIColor? {
        guard hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        return UIColor(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }

    private static func rect(_ value: JSObject?) -> CGRect? {
        guard let value = value, let x = value["x"] as? Double, let y = value["y"] as? Double,
              let width = value["width"] as? Double, let height = value["height"] as? Double else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }
}
