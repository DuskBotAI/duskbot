import UIKit

/// Home's top buttons (Search, New bot) in the system's Liquid Glass, as the chat's header draws its own: the page keeps
/// its buttons in place, unseen, and a tap here clicks them. The list they sit on moves a third as far as a chat page
/// sliding over it and goes under that page, so the bar rides the same path and is clipped at the page's edge.
@available(iOS 26.0, *)
final class GlassHomeBar {
    private static let underShift: CGFloat = 0.3
    private static let symbols: [String: (name: String, size: CGFloat)] = ["search": ("magnifyingglass", 17), "newBot": ("plus", 19)]
    private static let slideKeys = ["home-slide", "home-clip"]

    private let bar = PassthroughGlassContainerView(spacing: 12)
    private let clip = CALayer()
    private var buttons: [String: UIButton] = [:]
    private var shown = false
    private let emit: ([String: Any]) -> Void

    init(host: UIView, below: UIView, emit: @escaping ([String: Any]) -> Void) {
        self.emit = emit
        bar.frame = host.bounds
        bar.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        bar.isHidden = true
        clip.backgroundColor = UIColor.black.cgColor
        clip.anchorPoint = .zero
        clip.frame = bar.bounds
        bar.layer.mask = clip
        host.insertSubview(bar, belowSubview: below)
    }

    var view: UIView { bar }

    /// `data` nil hides the bar at once: something covers the buttons and the page draws its own in the same frame.
    func apply(_ data: [String: Any]?) {
        guard let data, let list = data["buttons"] as? [[String: Any]], !list.isEmpty else {
            show(false)
            return
        }
        if let dark = data["dark"] as? Bool { bar.overrideUserInterfaceStyle = dark ? .dark : .light }
        var seen = Set<String>()
        for item in list {
            guard let kind = item["kind"] as? String, let frame = Frame(item["frame"]), let symbol = Self.symbols[kind] else { continue }
            seen.insert(kind)
            let button = buttons[kind] ?? make(kind, symbol: symbol)
            if button.frame != frame.rect { button.frame = frame.rect }
            if let label = item["label"] as? String, !label.isEmpty { button.accessibilityLabel = label }
        }
        for (kind, button) in buttons where !seen.contains(kind) {
            button.removeFromSuperview()
            buttons[kind] = nil
        }
        show(true)
    }

    private func make(_ kind: String, symbol: (name: String, size: CGFloat)) -> UIButton {
        var config = UIButton.Configuration.glass()
        config.cornerStyle = .capsule
        config.image = UIImage(systemName: symbol.name, withConfiguration: UIImage.SymbolConfiguration(pointSize: symbol.size, weight: .medium))
        config.baseForegroundColor = .label
        let button = UIButton(configuration: config)
        button.addAction(UIAction { [weak self] _ in self?.emit(["type": "tap", "target": kind]) }, for: .touchUpInside)
        bar.contentView.addSubview(button)
        buttons[kind] = button
        return button
    }

    private func show(_ visible: Bool) {
        guard visible != shown else { return }
        shown = visible
        bar.isHidden = !visible
    }

    private func shift(_ page: CGFloat) -> CGFloat { -Self.underShift * max(0, bar.bounds.width - page) }

    /// Where a chat page's leading edge is (nil: no page over the list): the bar moves with the list and stops at it.
    func follow(page: CGFloat?) {
        let width = bar.bounds.width
        let x = min(page ?? width, width)
        for key in Self.slideKeys { bar.layer.removeAnimation(forKey: key); clip.removeAnimation(forKey: key) }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        bar.transform = CGAffineTransform(translationX: shift(x), y: 0)
        clip.frame = CGRect(x: 0, y: 0, width: max(0, x - shift(x)), height: bar.bounds.height)
        CATransaction.commit()
    }

    /// The page's slide, played in the transaction that slides the chat's chrome, with the same timing.
    func slide(_ points: [CGFloat], duration: TimeInterval, beginTime: CFTimeInterval) {
        guard let last = points.last else { return }
        let width = bar.bounds.width
        let pages = points.map { min($0, width) }
        let move = CAKeyframeAnimation.pageSlide(keyPath: "transform.translation.x", values: pages.map(shift), duration: duration, beginTime: beginTime)
        let reveal = CAKeyframeAnimation.pageSlide(keyPath: "bounds.size.width", values: pages.map { max(0, $0 - shift($0)) }, duration: duration, beginTime: beginTime)
        for (animation, layer, key) in [(move, bar.layer, Self.slideKeys[0]), (reveal, clip, Self.slideKeys[1])] {
            layer.removeAnimation(forKey: key)
            layer.add(animation, forKey: key)
        }
        let x = min(last, width)
        bar.transform = CGAffineTransform(translationX: shift(x), y: 0)
        clip.frame = CGRect(x: 0, y: 0, width: max(0, x - shift(x)), height: bar.bounds.height)
    }
}

/// Glass takeover button that handles the standard `paste(_:)` selector from a `UICommand` inside its `UIMenu`,
/// carrying UIKit's authenticated paste token so iOS 16+ reads `UIPasteboard.general` silently without a permission prompt.
@available(iOS 26.0, *)
private final class TakeoverGlassButton: UIButton {
    var onPasteAction: ((String) -> Void)?

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(UIResponderStandardEditActions.paste(_:)), onPasteAction != nil {
            return true
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        onPasteAction?(UIPasteboard.general.string ?? "")
    }
}

/// The fullscreen computer/browser takeover controls in the system's Liquid Glass (iOS 26+), drawn over the web view
/// so buttons get interactive glass refraction and native UIMenu morphing while the page keeps its own unseen buttons
/// underneath for layout and fallback.
@available(iOS 26.0, *)
final class GlassTakeoverBar {
    private struct MenuEntry: Equatable {
        let key: String
        let label: String
        let detail: String?
        let symbol: String?
        let checked: Bool
        let disabled: Bool
        let danger: Bool
        let separated: Bool
    }

    private struct ButtonSpec: Equatable {
        let symbol: String?
        let symbolSize: CGFloat
        let symbolWeight: UIImage.SymbolWeight
        let title: String?
        let compact: Bool
        let disabled: Bool
        let busy: Bool
        let interactive: Bool
        let menu: [MenuEntry]
    }

    private let bar = PassthroughGlassContainerView(spacing: 14)
    private var buttons: [String: TakeoverGlassButton] = [:]
    private var specs: [String: ButtonSpec] = [:]
    private var shown = false
    private let emit: ([String: Any]) -> Void

    init(host: UIView, emit: @escaping ([String: Any]) -> Void) {
        self.emit = emit
        bar.frame = host.bounds
        bar.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        bar.overrideUserInterfaceStyle = .dark
        bar.isHidden = true
        host.addSubview(bar)
    }

    var view: UIView { bar }

    func attach(to host: UIView) {
        guard bar.superview !== host else { return }
        bar.frame = host.bounds
        host.addSubview(bar)
    }

    func apply(_ data: [String: Any]?) {
        guard let data, let list = data["buttons"] as? [[String: Any]], !list.isEmpty else {
            clear()
            return
        }
        var seen = Set<String>()
        for item in list {
            guard let id = item["id"] as? String, let frame = Frame(item["frame"]), frame.rect.width > 1, frame.rect.height > 1 else { continue }
            seen.insert(id)
            let rawMenu = (item["menu"] as? [[String: Any]] ?? []).compactMap { entry -> MenuEntry? in
                guard let key = entry["key"] as? String, let label = entry["label"] as? String else { return nil }
                return MenuEntry(
                    key: key,
                    label: label,
                    detail: entry["detail"] as? String,
                    symbol: entry["symbol"] as? String,
                    checked: entry["checked"] as? Bool == true,
                    disabled: entry["disabled"] as? Bool == true,
                    danger: entry["danger"] as? Bool == true,
                    separated: entry["separated"] as? Bool == true
                )
            }
            let spec = ButtonSpec(
                symbol: item["symbol"] as? String,
                symbolSize: CGFloat((item["symbolSize"] as? NSNumber)?.doubleValue ?? 17),
                symbolWeight: (item["symbolWeight"] as? String) == "semibold" ? .semibold : .medium,
                title: item["title"] as? String,
                compact: item["compact"] as? Bool == true,
                disabled: item["disabled"] as? Bool == true,
                busy: item["busy"] as? Bool == true,
                interactive: item["interactive"] as? Bool ?? true,
                menu: rawMenu
            )
            let existed = buttons[id] != nil
            let button = buttons[id] ?? make(id)
            if specs[id] != spec {
                let menuChanged = specs[id]?.menu != spec.menu
                specs[id] = spec
                configure(button, id: id, spec: spec, updateMenu: menuChanged)
            }
            let targetFrame = fittedFrame(for: button, requested: frame.rect, spec: spec)
            if !button.isTracking, button.frame != targetFrame {
                if existed && id == "control" && !UIAccessibility.isReduceMotionEnabled {
                    UIView.animate(springDuration: 0.34, bounce: 0.22, options: [.allowUserInteraction, .beginFromCurrentState]) {
                        button.frame = targetFrame
                    }
                } else {
                    button.frame = targetFrame
                }
            }
            if let label = item["label"] as? String, !label.isEmpty, button.accessibilityLabel != label {
                button.accessibilityLabel = label
            }
        }
        for (id, button) in buttons where !seen.contains(id) {
            button.removeFromSuperview()
            buttons[id] = nil
            specs[id] = nil
        }
        show(!buttons.isEmpty)
    }

    private func clear() {
        show(false)
        for (_, button) in buttons { button.removeFromSuperview() }
        buttons.removeAll()
        specs.removeAll()
    }

    private func make(_ id: String) -> TakeoverGlassButton {
        let button = TakeoverGlassButton(configuration: .glass())
        button.overrideUserInterfaceStyle = .dark
        button.addAction(UIAction { [weak self] _ in
            guard let self, self.specs[id]?.menu.isEmpty != false else { return }
            self.emit(["type": "takeoverTap", "target": id])
        }, for: .touchUpInside)
        bar.contentView.addSubview(button)
        buttons[id] = button
        return button
    }

    private func fittedFrame(for button: UIButton, requested: CGRect, spec: ButtonSpec) -> CGRect {
        guard let title = spec.title, !title.isEmpty, !spec.busy else { return requested }
        let maxWidth = max(requested.width, min(240, max(120, bar.bounds.width - 120)))
        let fitted = ceil(button.sizeThatFits(CGSize(width: maxWidth, height: requested.height)).width)
        let width = max(requested.width, min(maxWidth, fitted))
        if abs(width - requested.width) < 0.5 { return requested }
        return CGRect(x: requested.maxX - width, y: requested.minY, width: width, height: requested.height)
    }

    private func configure(_ button: TakeoverGlassButton, id: String, spec: ButtonSpec, updateMenu: Bool) {
        var config = UIButton.Configuration.glass()
        config.cornerStyle = .capsule
        config.baseForegroundColor = spec.interactive ? .label : UIColor.white.withAlphaComponent(0.75)
        if spec.busy {
            config.showsActivityIndicator = true
            config.attributedTitle = nil
            config.image = nil
        } else if let title = spec.title, !title.isEmpty {
            var attributed = AttributedString(title)
            attributed.font = UIFont.systemFont(ofSize: spec.compact ? 13 : 15, weight: .medium)
            config.attributedTitle = attributed
            config.titleLineBreakMode = .byTruncatingTail
            config.contentInsets = NSDirectionalEdgeInsets(
                top: 0,
                leading: spec.compact ? 12 : 16,
                bottom: 0,
                trailing: spec.compact ? 12 : 16
            )
        } else if let symbol = spec.symbol, !symbol.isEmpty {
            config.image = UIImage(
                systemName: symbol,
                withConfiguration: UIImage.SymbolConfiguration(pointSize: spec.symbolSize, weight: spec.symbolWeight)
            )
            config.contentInsets = .zero
        }
        button.configuration = config
        button.isEnabled = !spec.disabled
        button.isUserInteractionEnabled = spec.interactive
        if updateMenu {
            button.onPasteAction = nil
            if spec.menu.isEmpty {
                button.menu = nil
                button.showsMenuAsPrimaryAction = false
            } else {
                var groups: [[UIMenuElement]] = [[]]
                for entry in spec.menu {
                    if entry.separated, !(groups.last ?? []).isEmpty { groups.append([]) }
                    var attributes: UIMenuElement.Attributes = []
                    if entry.danger { attributes.insert(.destructive) }
                    if entry.disabled { attributes.insert(.disabled) }
                    let image = entry.symbol.flatMap { UIImage(systemName: $0) }
                    if entry.key == "paste" && !entry.disabled {
                        button.onPasteAction = { [weak self] text in
                            self?.emit(["type": "takeoverMenu", "target": id, "key": entry.key, "text": text])
                        }
                        let command = UICommand(
                            title: entry.label,
                            image: image,
                            action: #selector(UIResponderStandardEditActions.paste(_:)),
                            propertyList: nil,
                            alternates: [],
                            discoverabilityTitle: nil,
                            attributes: attributes,
                            state: entry.checked ? .on : .off
                        )
                        if let detail = entry.detail { command.subtitle = detail }
                        groups[groups.count - 1].append(command)
                        continue
                    }
                    let action = UIAction(
                        title: entry.label,
                        image: image,
                        attributes: attributes,
                        state: entry.checked ? .on : .off
                    ) { [weak self] _ in
                        self?.emit(["type": "takeoverMenu", "target": id, "key": entry.key])
                    }
                    if let detail = entry.detail { action.subtitle = detail }
                    groups[groups.count - 1].append(action)
                }
                let children: [UIMenuElement] = groups.count == 1 ? groups[0] : groups.map { UIMenu(options: .displayInline, children: $0) }
                button.showsMenuAsPrimaryAction = true
                button.preferredMenuElementOrder = .fixed
                button.menu = UIMenu(children: children)
            }
        }
    }

    private func show(_ visible: Bool) {
        guard visible != shown else { return }
        shown = visible
        bar.isHidden = !visible
    }
}

/// Floating swipe-to-reply orb in native Liquid Glass (iOS 26+), refracting the chat behind a swiped message bubble
/// and springing with a luminous fill + symbol swap when the drag crosses the reply threshold.
@available(iOS 26.0, *)
final class GlassSwipeReplyBadge: GlassOrbBase {
    private static let symbolConfig = UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
    private static let idleImage = UIImage(systemName: "arrowshape.turn.up.left", withConfiguration: symbolConfig)
    private static let armedImage = UIImage(systemName: "arrowshape.turn.up.left.fill", withConfiguration: symbolConfig)

    private var restCenter = CGPoint.zero

    init(host: UIView, below: UIView) {
        super.init(host: host, below: below, size: 36, image: Self.idleImage, tintAlpha: 0.14, armedDuration: 0.36, armedBounce: 0.46)
    }

    func apply(_ data: [String: Any]?, instant: Bool = false) {
        guard let data,
              let x = (data["x"] as? NSNumber).map({ CGFloat($0.doubleValue) }),
              let y = (data["y"] as? NSNumber).map({ CGFloat($0.doubleValue) }),
              let progress = (data["progress"] as? NSNumber).map({ CGFloat($0.doubleValue) }) else {
            dismiss(instant: instant)
            return
        }
        let size = max(24, (data["size"] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 36)
        let restX = (data["restX"] as? NSNumber).map { CGFloat($0.doubleValue) } ?? x
        let nextArmed = data["armed"] as? Bool == true
        if let dark = data["dark"] as? Bool {
            layerView.overrideUserInterfaceStyle = dark ? .dark : .light
        }

        let clampedProgress = min(1, max(0, progress))
        let overscroll = min(1, max(0, (data["overscroll"] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 0))
        restCenter = CGPoint(x: restX, y: y)

        if !shown {
            beginShow { icon.image = Self.idleImage }
        }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if abs(container.bounds.width - size) > 0.5 || abs(container.bounds.height - size) > 0.5 {
            container.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        }
        container.center = CGPoint(x: x, y: y)
        let pullScale = 0.6 + 0.4 * clampedProgress
        let stretch = nextArmed ? overscroll * 0.10 : 0
        container.transform = CGAffineTransform(scaleX: pullScale * (1 + stretch), y: pullScale * (1 - stretch * 0.45))
        container.alpha = min(1, clampedProgress * 1.2)
        CATransaction.commit()

        if nextArmed != armed {
            armed = nextArmed
            transitionArmed(nextArmed, image: nextArmed ? Self.armedImage : Self.idleImage)
        }
    }

    private func dismiss(instant: Bool) {
        dismissOrb(instant: instant, duration: 0.26, exit: {
            self.container.center = self.restCenter
            self.container.alpha = 0
            self.container.transform = CGAffineTransform(scaleX: 0.25, y: 0.25)
        })
    }
}
