import UIKit

/// Home's top buttons (Search, New bot) in the system's Liquid Glass, as the chat's header draws its own: the page keeps
/// its buttons in place, unseen, and a tap here clicks them. The list they sit on moves a third as far as a chat page
/// sliding over it and goes under that page, so the bar rides the same path and is clipped at the page's edge.
@available(iOS 26.0, *)
final class GlassHomeBar {
    private static let underShift: CGFloat = 0.3
    private static let symbols: [String: (name: String, size: CGFloat)] = ["search": ("magnifyingglass", 17), "newBot": ("plus", 19)]
    private static let slideKeys = ["home-slide", "home-clip"]

    private let bar = PassthroughView()
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
        bar.addSubview(button)
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
        let move = CAKeyframeAnimation(keyPath: "transform.translation.x")
        move.values = pages.map { NSNumber(value: Double(shift($0))) }
        let reveal = CAKeyframeAnimation(keyPath: "bounds.size.width")
        reveal.values = pages.map { NSNumber(value: Double(max(0, $0 - shift($0)))) }
        for (animation, layer, key) in [(move, bar.layer, Self.slideKeys[0]), (reveal, clip, Self.slideKeys[1])] {
            animation.duration = duration
            animation.calculationMode = .linear
            animation.beginTime = beginTime
            animation.fillMode = .backwards
            animation.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
            layer.removeAnimation(forKey: key)
            layer.add(animation, forKey: key)
        }
        let x = min(last, width)
        bar.transform = CGAffineTransform(translationX: shift(x), y: 0)
        clip.frame = CGRect(x: 0, y: 0, width: max(0, x - shift(x)), height: bar.bounds.height)
    }
}
