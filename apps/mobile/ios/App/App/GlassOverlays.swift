import UIKit

/// Transparent `UIGlassContainerEffect` host so grouped Liquid Glass controls share unified optical refraction and
/// edge-merging while touches outside the buttons still reach the web view underneath.
@available(iOS 26.0, *)
final class PassthroughGlassContainerView: UIVisualEffectView {
    var onLayout: (() -> Void)?

    init(spacing: CGFloat) {
        let effect = UIGlassContainerEffect()
        effect.spacing = spacing
        super.init(effect: effect)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self || hit === contentView ? nil : hit
    }
}

private final class LayoutPassthroughView: PassthroughView {
    var onLayout: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}

/// Pull-to-refresh orb in native Liquid Glass (iOS 26+), sliding out below the navigation bar as the list pulls down,
/// popping with a spring when crossing the refresh threshold, and morphing to a native activity indicator while loading.
extension CAKeyframeAnimation {
    static func pageSlide(keyPath: String, values: [CGFloat], duration: TimeInterval, beginTime: CFTimeInterval) -> CAKeyframeAnimation {
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        animation.values = values.map { NSNumber(value: Double($0)) }
        animation.duration = duration
        animation.calculationMode = .linear
        animation.beginTime = beginTime
        animation.fillMode = .backwards
        animation.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
        return animation
    }
}

extension UIImage {
    static func fromDataURL(_ data: String) -> UIImage? {
        guard data.hasPrefix("data:image/"), let comma = data.firstIndex(of: ",") else { return nil }
        let encoded = String(data[data.index(after: comma)...])
        guard let bytes = Data(base64Encoded: encoded) else { return nil }
        return UIImage(data: bytes)
    }
}

/// Shared Liquid Glass floating orb base for pull-to-refresh and swipe-to-reply badges.
@available(iOS 26.0, *)
class GlassOrbBase {
    let layerView = UIView()
    let container = UIView()
    let orb = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
    let icon = UIImageView()
    var shown = false
    var armed = false
    var generation = 0

    private let tintAlpha: CGFloat
    private let armedDuration: TimeInterval
    private let armedBounce: CGFloat

    init(host: UIView, below: UIView, size: CGFloat, image: UIImage?, tintAlpha: CGFloat, armedDuration: TimeInterval, armedBounce: CGFloat) {
        self.tintAlpha = tintAlpha
        self.armedDuration = armedDuration
        self.armedBounce = armedBounce

        layerView.frame = host.bounds
        layerView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        layerView.isUserInteractionEnabled = false
        layerView.isHidden = true

        container.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        container.isUserInteractionEnabled = false
        container.alpha = 0

        orb.frame = container.bounds
        orb.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        orb.cornerConfiguration = .capsule()
        orb.isUserInteractionEnabled = false

        icon.frame = orb.contentView.bounds
        icon.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        icon.contentMode = .center
        icon.image = image
        icon.tintColor = .secondaryLabel
        icon.isUserInteractionEnabled = false

        orb.contentView.addSubview(icon)
        container.addSubview(orb)
        layerView.addSubview(container)
        host.insertSubview(layerView, belowSubview: below)
    }

    var view: UIView { layerView }

    func makeEffect(armed: Bool) -> UIGlassEffect {
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = armed
        if armed { effect.tintColor = UIColor.label.withAlphaComponent(tintAlpha) }
        return effect
    }

    func beginShow(reset: () -> Void = {}) {
        generation += 1
        shown = true
        armed = false
        container.layer.removeAllAnimations()
        orb.layer.removeAllAnimations()
        orb.transform = .identity
        orb.effect = makeEffect(armed: false)
        icon.tintColor = .secondaryLabel
        reset()
        layerView.isHidden = false
    }

    func transitionArmed(_ isArmed: Bool, image: UIImage? = nil) {
        if let image { icon.image = image }
        icon.tintColor = isArmed ? .label : .secondaryLabel
        let effect = makeEffect(armed: isArmed)
        if UIAccessibility.isReduceMotionEnabled {
            orb.effect = effect
            orb.transform = isArmed ? CGAffineTransform(scaleX: 1.06, y: 1.06) : .identity
            return
        }
        if isArmed {
            orb.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
            UIView.animate(springDuration: armedDuration, bounce: armedBounce) {
                self.orb.effect = effect
                self.orb.transform = CGAffineTransform(scaleX: 1.08, y: 1.08)
            }
        } else {
            UIView.animate(withDuration: 0.18, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
                self.orb.effect = effect
                self.orb.transform = .identity
            }
        }
    }

    func dismissOrb(instant: Bool, duration: TimeInterval, exit: @escaping () -> Void, cleanup: @escaping () -> Void = {}) {
        guard shown || !layerView.isHidden else { return }
        shown = false
        armed = false
        generation += 1
        let gen = generation
        if instant || UIAccessibility.isReduceMotionEnabled {
            container.layer.removeAllAnimations()
            orb.layer.removeAllAnimations()
            cleanup()
            container.alpha = 0
            container.transform = .identity
            orb.transform = .identity
            orb.effect = makeEffect(armed: false)
            layerView.isHidden = true
            return
        }
        UIView.animate(withDuration: duration, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
            exit()
            self.orb.transform = .identity
        } completion: { [weak self] _ in
            guard let self, self.generation == gen else { return }
            cleanup()
            self.orb.effect = self.makeEffect(armed: false)
            self.layerView.isHidden = true
        }
    }
}

@available(iOS 26.0, *)
final class GlassPullRefreshOrb: GlassOrbBase {
    private static let orbSize: CGFloat = 42
    private static let symbolConfig = UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)
    private static let arrowImage = UIImage(systemName: "arrow.clockwise", withConfiguration: symbolConfig)

    private let spinner = UIActivityIndicatorView(style: .medium)
    private var refreshing = false

    init(host: UIView, below: UIView) {
        super.init(host: host, below: below, size: Self.orbSize, image: Self.arrowImage, tintAlpha: 0.12, armedDuration: 0.34, armedBounce: 0.45)
        spinner.hidesWhenStopped = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.isUserInteractionEnabled = false
        orb.contentView.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: orb.contentView.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: orb.contentView.centerYAnchor),
        ])
    }

    func apply(_ data: [String: Any]?, instant: Bool = false) {
        guard let data,
              let y = (data["y"] as? NSNumber).map({ CGFloat($0.doubleValue) }),
              let progress = (data["progress"] as? NSNumber).map({ CGFloat($0.doubleValue) }) else {
            dismiss(instant: instant)
            return
        }
        let nextArmed = data["armed"] as? Bool == true
        let nextRefreshing = data["refreshing"] as? Bool == true
        if let dark = data["dark"] as? Bool {
            layerView.overrideUserInterfaceStyle = dark ? .dark : .light
        }
        let clamped = min(1, max(0, progress))
        if clamped <= 0.02 && !nextRefreshing {
            dismiss(instant: instant)
            return
        }

        if !shown {
            refreshing = false
            beginShow {
                icon.isHidden = false
                icon.alpha = 1
                spinner.stopAnimating()
            }
        }

        let centerX = layerView.bounds.width / 2
        let pullScale: CGFloat = nextRefreshing ? 1 : (0.56 + 0.44 * clamped)
        let alpha: CGFloat = nextRefreshing ? 1 : min(1, clamped * 1.25)

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        container.center = CGPoint(x: centerX, y: y)
        container.transform = CGAffineTransform(scaleX: pullScale, y: pullScale)
        container.alpha = alpha
        if !nextRefreshing {
            icon.transform = CGAffineTransform(rotationAngle: min(1.35, max(0, progress)) * .pi * 1.35)
        }
        CATransaction.commit()

        if nextRefreshing != refreshing {
            refreshing = nextRefreshing
            transitionRefreshing(nextRefreshing)
        }
        if !nextRefreshing && nextArmed != armed {
            armed = nextArmed
            transitionArmed(nextArmed)
        }
    }

    private func transitionRefreshing(_ isRefreshing: Bool) {
        if isRefreshing {
            spinner.color = .label
            spinner.startAnimating()
            UIView.animate(springDuration: 0.32, bounce: 0.25) {
                self.icon.alpha = 0
                self.orb.effect = self.makeEffect(armed: false)
                self.orb.transform = .identity
            }
        } else {
            spinner.stopAnimating()
            icon.alpha = 1
        }
    }

    private func dismiss(instant: Bool) {
        refreshing = false
        dismissOrb(
            instant: instant,
            duration: 0.24,
            exit: {
                self.container.alpha = 0
                self.container.transform = CGAffineTransform(scaleX: 0.4, y: 0.4)
                self.container.center = CGPoint(x: self.container.center.x, y: self.container.center.y - 12)
            },
            cleanup: { self.spinner.stopAnimating() }
        )
    }
}

/// Fullscreen photo viewer controls (Close, Share, multi-image counter pill) in native Liquid Glass (iOS 26+),
/// grouped inside a `UIGlassContainerEffect` so buttons refract the zoomed photo underneath.
@available(iOS 26.0, *)
final class GlassImageViewerBar {
    private static let closeConfig = UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)
    private static let shareConfig = UIImage.SymbolConfiguration(pointSize: 16, weight: .medium)

    private let container = PassthroughGlassContainerView(spacing: 14)
    private let closeButton = UIButton(configuration: .glass())
    private let shareButton = UIButton(configuration: .glass())
    private let countPill = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
    private let countLabel = UILabel()
    private var shown = false
    private var chromeVisible = false
    private var sharing = false
    private var countCenterY: CGFloat?
    private let emit: ([String: Any]) -> Void

    init(host: UIView, emit: @escaping ([String: Any]) -> Void) {
        self.emit = emit
        container.frame = host.bounds
        container.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.overrideUserInterfaceStyle = .dark
        container.alpha = 0
        container.isHidden = true
        container.onLayout = { [weak self] in self?.repositionCountPill(animated: false) }

        var closeCfg = UIButton.Configuration.glass()
        closeCfg.cornerStyle = .capsule
        closeCfg.image = UIImage(systemName: "xmark", withConfiguration: Self.closeConfig)
        closeCfg.baseForegroundColor = .white
        closeCfg.contentInsets = .zero
        closeButton.configuration = closeCfg
        closeButton.overrideUserInterfaceStyle = .dark
        closeButton.addAction(UIAction { [weak self] _ in
            self?.emit(["type": "viewerTap", "target": "close"])
        }, for: .touchUpInside)

        var shareCfg = UIButton.Configuration.glass()
        shareCfg.cornerStyle = .capsule
        shareCfg.image = UIImage(systemName: "square.and.arrow.up", withConfiguration: Self.shareConfig)
        shareCfg.baseForegroundColor = .white
        shareCfg.contentInsets = .zero
        shareButton.configuration = shareCfg
        shareButton.overrideUserInterfaceStyle = .dark
        shareButton.isHidden = true
        shareButton.addAction(UIAction { [weak self] _ in
            self?.emit(["type": "viewerTap", "target": "share"])
        }, for: .touchUpInside)

        countPill.cornerConfiguration = .capsule()
        countPill.overrideUserInterfaceStyle = .dark
        countPill.isUserInteractionEnabled = false
        countPill.isHidden = true

        countLabel.font = .monospacedDigitSystemFont(ofSize: 14, weight: .semibold)
        countLabel.textColor = .white
        countLabel.textAlignment = .center
        countLabel.translatesAutoresizingMaskIntoConstraints = false
        countPill.contentView.addSubview(countLabel)
        NSLayoutConstraint.activate([
            countLabel.leadingAnchor.constraint(equalTo: countPill.contentView.leadingAnchor, constant: 13),
            countLabel.trailingAnchor.constraint(equalTo: countPill.contentView.trailingAnchor, constant: -13),
            countLabel.topAnchor.constraint(equalTo: countPill.contentView.topAnchor, constant: 6),
            countLabel.bottomAnchor.constraint(equalTo: countPill.contentView.bottomAnchor, constant: -6),
        ])

        [closeButton, countPill, shareButton].forEach(container.contentView.addSubview)
        host.addSubview(container)
    }

    var view: UIView { container }

    func apply(_ data: [String: Any]?) {
        guard let data, let closeFrame = Frame(data["close"]) else {
            hide()
            return
        }
        let visible = data["visible"] as? Bool ?? true
        if !closeButton.isTracking, closeButton.frame != closeFrame.rect {
            closeButton.frame = closeFrame.rect
        }
        if let label = data["closeLabel"] as? String, !label.isEmpty {
            closeButton.accessibilityLabel = label
        }

        if let shareFrame = Frame(data["share"]) {
            shareButton.isHidden = false
            if !shareButton.isTracking, shareButton.frame != shareFrame.rect {
                shareButton.frame = shareFrame.rect
            }
            if let label = data["shareLabel"] as? String, !label.isEmpty {
                shareButton.accessibilityLabel = label
            }
            setSharing(data["sharing"] as? Bool == true)
        } else {
            shareButton.isHidden = true
        }

        if let countText = data["countText"] as? String, !countText.isEmpty {
            countLabel.text = countText
            countCenterY = (data["countY"] as? NSNumber).map { CGFloat($0.doubleValue) } ?? closeFrame.rect.midY
            let wasHidden = countPill.isHidden
            countPill.isHidden = false
            repositionCountPill(animated: !wasHidden)
        } else {
            countCenterY = nil
            countPill.isHidden = true
        }

        container.isUserInteractionEnabled = visible
        if !shown {
            shown = true
            chromeVisible = visible
            container.isHidden = false
            container.alpha = visible ? 1 : 0
        } else if chromeVisible != visible {
            chromeVisible = visible
            let targetAlpha: CGFloat = visible ? 1 : 0
            if UIAccessibility.isReduceMotionEnabled {
                container.alpha = targetAlpha
            } else {
                UIView.animate(withDuration: 0.16, delay: 0, options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction]) {
                    self.container.alpha = targetAlpha
                }
            }
        }
    }

    private func setSharing(_ next: Bool) {
        guard next != sharing else { return }
        sharing = next
        var cfg = shareButton.configuration ?? UIButton.Configuration.glass()
        cfg.showsActivityIndicator = next
        cfg.image = next ? nil : UIImage(systemName: "square.and.arrow.up", withConfiguration: Self.shareConfig)
        shareButton.configuration = cfg
        shareButton.isEnabled = !next
    }

    private func repositionCountPill(animated: Bool) {
        guard !countPill.isHidden, let centerY = countCenterY else { return }
        let labelSize = countLabel.sizeThatFits(CGSize(width: max(80, container.bounds.width - 140), height: 32))
        let w = max(54, ceil(labelSize.width) + 26)
        let h = max(32, ceil(labelSize.height) + 12)
        let target = CGRect(x: round((container.bounds.width - w) / 2), y: round(centerY - h / 2), width: w, height: h)
        guard countPill.frame != target else { return }
        if animated && !UIAccessibility.isReduceMotionEnabled {
            UIView.animate(springDuration: 0.28, bounce: 0.15) {
                self.countPill.frame = target
            }
        } else {
            countPill.frame = target
        }
    }

    private func hide() {
        guard shown || !container.isHidden else { return }
        shown = false
        chromeVisible = false
        setSharing(false)
        countCenterY = nil
        container.isUserInteractionEnabled = false
        container.alpha = 0
        container.isHidden = true
    }
}

/// Floating Liquid Glass pill for ephemeral status/toast/hint banners (`top` under header or `bottom` above composer),
/// with interactive touch glow/swell when clickable, optional Undo/Retry action button, and swipe-down dismissal.
@available(iOS 26.0, *)
final class GlassFloatingPill: NSObject {
    enum Slot: String { case top, bottom }

    private struct Spec: Equatable {
        let id: String
        let text: String
        let tone: String
        let symbol: String?
        let trailingSymbol: String?
        let spinner: Bool
        let offset: CGFloat
        let dark: Bool
        let tappable: Bool
        let actionLabel: String?
        let actionDisabled: Bool
        let dismissible: Bool
    }

    private let slot: Slot
    private let emit: ([String: Any]) -> Void
    private let layerView = LayoutPassthroughView()
    private let pill = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
    private let stack = UIStackView()
    private let spinnerView = UIActivityIndicatorView(style: .medium)
    private let leadingIcon = UIImageView()
    private let textLabel = UILabel()
    private let trailingIcon = UIImageView()
    private let actionButton = UIButton(configuration: .plain())
    private let closeButton = UIButton(configuration: .plain())
    private var tapGesture: UITapGestureRecognizer!
    private var panGesture: UIPanGestureRecognizer!

    private var spec: Spec?
    private var shown = false
    private var generation = 0

    init(slot: Slot, host: UIView, emit: @escaping ([String: Any]) -> Void) {
        self.slot = slot
        self.emit = emit
        super.init()

        layerView.frame = host.bounds
        layerView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        layerView.isHidden = true
        layerView.onLayout = { [weak self] in
            guard let self, self.shown, let spec = self.spec, self.panGesture.state == .possible else { return }
            let target = self.fittedFrame(offset: spec.offset)
            if self.pill.frame != target { self.pill.frame = target }
        }

        pill.cornerConfiguration = .capsule()
        pill.alpha = 0

        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 7
        stack.translatesAutoresizingMaskIntoConstraints = false

        spinnerView.hidesWhenStopped = true
        spinnerView.transform = CGAffineTransform(scaleX: 0.8, y: 0.8)

        leadingIcon.contentMode = .scaleAspectFit
        leadingIcon.setContentHuggingPriority(.required, for: .horizontal)
        leadingIcon.setContentCompressionResistancePriority(.required, for: .horizontal)

        textLabel.font = .systemFont(ofSize: 14, weight: .medium)
        textLabel.numberOfLines = 2
        textLabel.lineBreakMode = .byTruncatingTail
        textLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        trailingIcon.contentMode = .scaleAspectFit
        trailingIcon.setContentHuggingPriority(.required, for: .horizontal)
        trailingIcon.setContentCompressionResistancePriority(.required, for: .horizontal)

        var actCfg = UIButton.Configuration.filled()
        actCfg.cornerStyle = .capsule
        actCfg.contentInsets = NSDirectionalEdgeInsets(top: 5, leading: 11, bottom: 5, trailing: 11)
        actCfg.baseBackgroundColor = UIColor.label.withAlphaComponent(0.14)
        actCfg.baseForegroundColor = .label
        actionButton.configuration = actCfg
        actionButton.setContentHuggingPriority(.required, for: .horizontal)
        actionButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        actionButton.addAction(UIAction { [weak self] _ in
            guard let self, let id = self.spec?.id else { return }
            self.emit(["type": "pillTap", "slot": self.slot.rawValue, "id": id, "kind": "action"])
        }, for: .touchUpInside)

        var closeCfg = UIButton.Configuration.plain()
        closeCfg.cornerStyle = .capsule
        closeCfg.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4)
        closeCfg.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .bold))
        closeCfg.baseForegroundColor = .secondaryLabel
        closeButton.configuration = closeCfg
        closeButton.accessibilityLabel = "Dismiss"
        closeButton.setContentHuggingPriority(.required, for: .horizontal)
        closeButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        closeButton.addAction(UIAction { [weak self] _ in
            guard let self, let id = self.spec?.id else { return }
            self.emit(["type": "pillTap", "slot": self.slot.rawValue, "id": id, "kind": "dismiss"])
        }, for: .touchUpInside)

        [spinnerView, leadingIcon, textLabel, trailingIcon, actionButton, closeButton].forEach(stack.addArrangedSubview)
        pill.contentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: pill.contentView.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: pill.contentView.trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: pill.contentView.topAnchor, constant: 9),
            stack.bottomAnchor.constraint(equalTo: pill.contentView.bottomAnchor, constant: -9),
        ])

        tapGesture = UITapGestureRecognizer(target: self, action: #selector(handlePillTap))
        pill.addGestureRecognizer(tapGesture)
        panGesture = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pill.addGestureRecognizer(panGesture)

        layerView.addSubview(pill)
        host.addSubview(layerView)
    }

    var view: UIView { layerView }

    func apply(_ data: [String: Any]?, clearId: String? = nil, instant: Bool = false) {
        guard let data,
              let id = data["id"] as? String,
              let text = data["text"] as? String, !text.isEmpty else {
            if let clearId, let currentId = spec?.id, currentId != clearId { return }
            dismiss(instant: instant)
            return
        }
        let next = Spec(
            id: id,
            text: text,
            tone: data["tone"] as? String ?? "neutral",
            symbol: data["symbol"] as? String,
            trailingSymbol: data["trailingSymbol"] as? String,
            spinner: data["spinner"] as? Bool == true,
            offset: (data["offset"] as? NSNumber).map { CGFloat($0.doubleValue) } ?? (slot == .top ? 104 : 28),
            dark: data["dark"] as? Bool ?? true,
            tappable: data["tappable"] as? Bool == true,
            actionLabel: data["actionLabel"] as? String,
            actionDisabled: data["actionDisabled"] as? Bool == true,
            dismissible: data["dismissible"] as? Bool == true
        )

        let wasShown = shown
        let previous = spec
        if wasShown && previous == next { return }
        spec = next

        layerView.overrideUserInterfaceStyle = next.dark ? .dark : .light
        let interactive = next.tappable || next.dismissible || (next.actionLabel != nil)
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = interactive
        if next.tone == "error" {
            effect.tintColor = UIColor.systemRed.withAlphaComponent(0.14)
        }
        pill.effect = effect
        pill.isUserInteractionEnabled = interactive
        tapGesture.isEnabled = next.tappable
        panGesture.isEnabled = next.dismissible

        if next.spinner {
            spinnerView.color = .secondaryLabel
            spinnerView.isHidden = false
            spinnerView.startAnimating()
            leadingIcon.isHidden = true
        } else {
            spinnerView.stopAnimating()
            spinnerView.isHidden = true
            if let symbol = next.symbol, !symbol.isEmpty,
               let image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)) {
                leadingIcon.image = image
                leadingIcon.tintColor = next.tone == "error" ? .systemRed : next.tone == "success" ? .label : .secondaryLabel
                leadingIcon.isHidden = false
            } else {
                leadingIcon.isHidden = true
            }
        }

        textLabel.text = next.text
        textLabel.textColor = next.tone == "error" ? UIColor(red: 1, green: 0.42, blue: 0.39, alpha: 1) : .label

        if let trailing = next.trailingSymbol, !trailing.isEmpty,
           let image = UIImage(systemName: trailing, withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)) {
            trailingIcon.image = image
            trailingIcon.tintColor = .secondaryLabel
            trailingIcon.isHidden = false
        } else {
            trailingIcon.isHidden = true
        }

        if let actionTitle = next.actionLabel, !actionTitle.isEmpty {
            var title = AttributedString(actionTitle)
            title.font = .systemFont(ofSize: 13, weight: .semibold)
            actionButton.configuration?.attributedTitle = title
            actionButton.isEnabled = !next.actionDisabled
            actionButton.isHidden = false
        } else {
            actionButton.isHidden = true
        }
        closeButton.isHidden = !next.dismissible

        let targetFrame = fittedFrame(offset: next.offset)

        if !wasShown {
            generation += 1
            shown = true
            pill.layer.removeAllAnimations()
            layerView.isHidden = false
            pill.transform = .identity
            pill.frame = targetFrame
            let startShift: CGFloat = slot == .top ? -12 : 14
            if instant || UIAccessibility.isReduceMotionEnabled {
                pill.alpha = 1
                pill.transform = .identity
            } else {
                pill.alpha = 0
                pill.transform = CGAffineTransform(translationX: 0, y: startShift).scaledBy(x: 0.88, y: 0.88)
                UIView.animate(springDuration: 0.38, bounce: 0.30, options: [.allowUserInteraction]) {
                    self.pill.alpha = 1
                    self.pill.transform = .identity
                }
            }
        } else if previous != next {
            if UIAccessibility.isReduceMotionEnabled {
                pill.frame = targetFrame
            } else {
                UIView.animate(springDuration: 0.30, bounce: 0.18, options: [.allowUserInteraction, .beginFromCurrentState]) {
                    self.pill.frame = targetFrame
                }
            }
        }
    }

    private func fittedFrame(offset: CGFloat) -> CGRect {
        let hostW = max(240, layerView.bounds.width)
        let hostH = max(320, layerView.bounds.height)
        let maxW = min(360, hostW - 32)
        let horizontalPad: CGFloat = 28
        let verticalPad: CGFloat = 18
        var chromeW: CGFloat = 0
        if !spinnerView.isHidden { chromeW += 22 + stack.spacing }
        if !leadingIcon.isHidden { chromeW += 20 + stack.spacing }
        if !trailingIcon.isHidden { chromeW += 18 + stack.spacing }
        if !actionButton.isHidden {
            chromeW += max(52, ceil(actionButton.sizeThatFits(CGSize(width: 140, height: 30)).width)) + stack.spacing
        }
        if !closeButton.isHidden { chromeW += 24 + stack.spacing }
        textLabel.preferredMaxLayoutWidth = max(80, maxW - horizontalPad - chromeW)
        let measured = stack.systemLayoutSizeFitting(
            CGSize(width: maxW - horizontalPad, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .fittingSizeLevel,
            verticalFittingPriority: .fittingSizeLevel
        )
        let w = min(maxW, max(72, ceil(measured.width + horizontalPad)))
        let h = max(38, ceil(measured.height + verticalPad))
        let x = round((hostW - w) / 2)
        let y = slot == .top ? round(offset) : round(hostH - offset - h)
        return CGRect(x: x, y: y, width: w, height: h)
    }

    private func dismiss(instant: Bool) {
        guard shown || !layerView.isHidden else { spec = nil; return }
        shown = false
        spec = nil
        generation += 1
        let gen = generation
        let exitShift: CGFloat = slot == .top ? -10 : 14
        if instant || UIAccessibility.isReduceMotionEnabled {
            pill.layer.removeAllAnimations()
            spinnerView.stopAnimating()
            pill.alpha = 0
            pill.transform = .identity
            layerView.isHidden = true
            return
        }
        UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
            self.pill.alpha = 0
            self.pill.transform = CGAffineTransform(translationX: 0, y: exitShift).scaledBy(x: 0.9, y: 0.9)
        } completion: { [weak self] _ in
            guard let self, self.generation == gen else { return }
            self.spinnerView.stopAnimating()
            self.pill.transform = .identity
            self.layerView.isHidden = true
        }
    }

    @objc private func handlePillTap() {
        guard let spec, spec.tappable else { return }
        if !UIAccessibility.isReduceMotionEnabled {
            let gen = generation
            UIView.animate(springDuration: 0.26, bounce: 0.35) {
                self.pill.transform = CGAffineTransform(scaleX: 0.96, y: 0.96)
            } completion: { [weak self] _ in
                guard let self, self.generation == gen else { return }
                UIView.animate(springDuration: 0.28, bounce: 0.35) { self.pill.transform = .identity }
            }
        }
        emit(["type": "pillTap", "slot": slot.rawValue, "id": spec.id, "kind": "pill"])
    }

    @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
        guard let spec, spec.dismissible else { return }
        let dy = gesture.translation(in: layerView).y
        let dir: CGFloat = slot == .top ? -1 : 1
        let along = dy * dir
        switch gesture.state {
        case .changed:
            let shift = along >= 0 ? along * dir : -pow(-along, 0.72) * dir * 0.6
            pill.transform = CGAffineTransform(translationX: 0, y: shift)
            pill.alpha = max(0.35, 1 - max(0, along) / 96)
        case .ended, .cancelled:
            let vy = gesture.velocity(in: layerView).y * dir
            if along > 26 || vy > 320 {
                let id = spec.id
                dismiss(instant: false)
                emit(["type": "pillTap", "slot": slot.rawValue, "id": id, "kind": "dismiss"])
            } else {
                UIView.animate(springDuration: 0.34, bounce: 0.35, options: [.allowUserInteraction]) {
                    self.pill.transform = .identity
                    self.pill.alpha = 1
                }
            }
        default:
            break
        }
    }
}
