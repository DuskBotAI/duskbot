import Capacitor
import UIKit

/// The system's pull-down menu for a control in the page (a select, a "more" button): the page gives the control's frame
/// and its choices, and hears which one was picked, or nothing when the menu was closed without a pick.
@objc(PulldownMenuPlugin)
public class PulldownMenuPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PulldownMenuPlugin"
    public let jsName = "DuskPulldown"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise)
    ]

    /// An invisible button over the page's control: UIKit opens a menu only from a control or a touch of its own.
    private final class Anchor: UIButton {
        var closed: (() -> Void)?

        override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
            super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
            let closed = self.closed
            self.closed = nil
            if let animator = animator { animator.addCompletion { closed?() } } else { closed?() }
        }
    }

    @objc func show(_ call: CAPPluginCall) {
        guard let x = call.getDouble("x"), let y = call.getDouble("y"), let width = call.getDouble("width"), let height = call.getDouble("height") else {
            call.reject("An anchor frame is required.", "invalid")
            return
        }
        let items = (call.getArray("items") ?? []).compactMap { $0 as? [String: Any] }
        guard !items.isEmpty else {
            call.reject("A menu needs an item.", "invalid")
            return
        }
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController?.view else {
                call.resolve()
                return
            }
            var resolved = false
            let resolveOnce: ([String: Any]?) -> Void = { payload in
                guard !resolved else { return }
                resolved = true
                if let payload { call.resolve(payload) } else { call.resolve() }
            }
            if items.contains(where: { ($0["key"] as? String) == "attach:photos" }) {
                MediaPickerLibraryCache.shared.warmIfAuthorized()
            }
            var groups: [[UIMenuElement]] = [[]]
            for item in items {
                guard let key = item["key"] as? String, let label = item["label"] as? String else { continue }
                if item["separated"] as? Bool == true, !(groups.last ?? []).isEmpty { groups.append([]) }
                var attributes: UIMenuElement.Attributes = []
                if item["danger"] as? Bool == true { attributes.insert(.destructive) }
                if item["disabled"] as? Bool == true { attributes.insert(.disabled) }
                let action = UIAction(title: label, image: (item["symbol"] as? String).flatMap { UIImage(systemName: $0) }, attributes: attributes, state: item["checked"] as? Bool == true ? .on : .off) { _ in
                    resolveOnce(["key": key])
                }
                if let detail = item["detail"] as? String { action.subtitle = detail }
                groups[groups.count - 1].append(action)
            }
            let children: [UIMenuElement] = groups.count == 1 ? groups[0] : groups.map { UIMenu(options: .displayInline, children: $0) }

            guard #available(iOS 17.4, *) else {
                self.sheet(call: call, items: items, host: host, frame: CGRect(x: x, y: y, width: width, height: height))
                return
            }
            let anchor = Anchor(frame: CGRect(x: x, y: y, width: width, height: height))
            anchor.isAccessibilityElement = false
            anchor.showsMenuAsPrimaryAction = true
            anchor.preferredMenuElementOrder = .fixed
            anchor.menu = UIMenu(children: children)
            anchor.closed = { [weak anchor] in
                anchor?.removeFromSuperview()
                resolveOnce(nil)
            }
            host.addSubview(anchor)
            anchor.performPrimaryAction()
        }
    }

    /// Before iOS 17.4 a menu cannot be opened for a control from code: the same choices as an action sheet.
    private func sheet(call: CAPPluginCall, items: [[String: Any]], host: UIView, frame: CGRect) {
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        for item in items {
            guard let key = item["key"] as? String, let label = item["label"] as? String else { continue }
            let action = UIAlertAction(title: label, style: item["danger"] as? Bool == true ? .destructive : .default) { _ in call.resolve(["key": key]) }
            action.isEnabled = item["disabled"] as? Bool != true
            sheet.addAction(action)
        }
        sheet.addAction(UIAlertAction(title: call.getString("cancel") ?? "Cancel", style: .cancel) { _ in call.resolve() })
        sheet.popoverPresentationController?.sourceView = host
        sheet.popoverPresentationController?.sourceRect = frame
        bridge?.viewController?.present(sheet, animated: true)
    }
}
