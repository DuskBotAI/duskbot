import Capacitor
import UIKit
import WebKit

struct ChromeBarSpec {
    let hidden: Bool
    let title: String?
    let status: String?
    let leading: [[String: Any]]
    let trailing: [[String: Any]]
}

private final class SnapshotViewController: UIViewController {
    private let snapshot: UIView
    private let ground: UIColor?
    let barSpec: ChromeBarSpec?
    let childToken: String

    init(snapshot: UIView, barSpec: ChromeBarSpec?, childToken: String, ground: UIColor?) {
        self.snapshot = snapshot
        self.barSpec = barSpec
        self.childToken = childToken
        self.ground = ground
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = ground
        snapshot.frame = view.bounds
        snapshot.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(snapshot)
    }
}

/// The window's root. The web view's controller sits in a navigation controller, so the page's floating controls are real
/// bar buttons, and a sheet is the same controller presented in a second navigation controller over a picture of the page
/// it left: one web view, the system's own bar, sheet, detents and gestures.
final class RootViewController: UIViewController, UINavigationControllerDelegate {
    let app = AppViewController()
    private(set) lazy var mainNavigation = UINavigationController(rootViewController: app)
    private var cover: UIView?
    private(set) var sheetNavigation: UINavigationController?
    private var sheetIsLarge = false

    var currentBarSpec: ChromeBarSpec?
    var applyBarItem: ((ChromeBarSpec, UINavigationItem, Bool, Bool) -> Void)?
    var onPagePopped: (([String]) -> Void)?

    private(set) var pushedTokens: [String] = []

    /// A push the page asked for and has not committed: a picture of the page it leaves and that page's bar, the bar
    /// the next page asks for meanwhile, and the picture over the sheet that the next page draws itself under.
    private struct PreparingPush {
        let snapshot: UIView
        let previousBar: ChromeBarSpec?
        var nextBar: ChromeBarSpec?
        let cover: UIView?
    }

    /// A pop the page asked for, until the system has shown the page under it.
    private struct ProgrammaticPop {
        let token: String
        let done: (Bool) -> Void
    }

    /// A pop that has landed: a picture of the sheet stays over it until the page says it has drawn itself there, or
    /// the timer stops waiting for it.
    private struct FinishingPop {
        let cover: UIView?
        let timer: Timer
    }

    private static let finishingPopWait: TimeInterval = 0.45

    private var preparingPush: PreparingPush?
    private var programmaticPop: ProgrammaticPop?
    private var finishingPop: FinishingPop?
    private var isSwappingPushStack = false

    var isFinishingPop: Bool { finishingPop != nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        app.onSafeAreaChange = { [weak self] in self?.reconcileSheetChrome(settled: false) }
        mainNavigation.setNavigationBarHidden(true, animated: false)
        addChild(mainNavigation)
        mainNavigation.view.frame = view.bounds
        mainNavigation.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(mainNavigation.view)
        mainNavigation.didMove(toParent: self)
    }

    override var childForStatusBarStyle: UIViewController? { nil }
    override var preferredStatusBarStyle: UIStatusBarStyle { sheetNavigation != nil && sheetIsLarge ? .lightContent : app.preferredStatusBarStyle }
    override var prefersStatusBarHidden: Bool { app.prefersStatusBarHidden }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { app.supportedInterfaceOrientations }

    /// A picture of the screen over everything, so the page can change what it draws underneath unseen.
    func freeze() {
        guard cover == nil, let picture = view.snapshotView(afterScreenUpdates: false) else { return }
        picture.frame = view.bounds
        view.addSubview(picture)
        cover = picture
    }

    func thaw() {
        guard let picture = cover else { return }
        cover = nil
        UIView.animate(withDuration: 0.14, animations: { picture.alpha = 0 }, completion: { _ in picture.removeFromSuperview() })
    }

    func presentSheet(height: CGFloat?, delegate: UIAdaptivePresentationControllerDelegate, shown: @escaping () -> Void) {
        guard sheetNavigation == nil else { shown(); return }
        let backdrop = UIViewController()
        backdrop.view.backgroundColor = app.view.backgroundColor
        if let picture = cover {
            cover = nil
            picture.frame = backdrop.view.bounds
            picture.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            backdrop.view.addSubview(picture)
        }
        let barHidden = mainNavigation.isNavigationBarHidden
        mainNavigation.setNavigationBarHidden(true, animated: false)
        mainNavigation.setViewControllers([backdrop], animated: false)

        let navigation = UINavigationController(rootViewController: app)
        navigation.delegate = self
        navigation.setNavigationBarHidden(barHidden, animated: false)
        navigation.modalPresentationStyle = .pageSheet
        navigation.presentationController?.delegate = delegate
        if let sheet = navigation.sheetPresentationController {
            sheet.prefersGrabberVisible = true
            sheet.prefersScrollingExpandsWhenScrolledToEdge = false
            if let height = height {
                sheetHeight = height
                // UISheetPresentationController.Detent.custom sizes above the sheet's bottom safe area and does not
                // add the navigation bar inside it (~78pt on iOS 26 before the sheet's own insets are laid out).
                sheetChromeAllowance = (barHidden ? 16 : 78) + max(16 - view.safeAreaInsets.bottom, 0)
                sheetResolvedDetent = 0
                sheetMaxDetent = 0
                sheet.detents = [.custom(identifier: .init("fit")) { [weak self] context in
                    guard let self = self else { return min(height, context.maximumDetentValue) }
                    let resolved = min(self.sheetHeight + self.sheetChromeAllowance, context.maximumDetentValue)
                    self.sheetResolvedDetent = resolved
                    self.sheetMaxDetent = context.maximumDetentValue
                    return resolved
                }]
            } else {
                sheet.detents = [.large()]
            }
        }
        sheetIsLarge = height == nil
        sheetNavigation = navigation
        present(navigation, animated: true) { [weak self] in
            self?.reconcileSheetChrome(settled: true)
            shown()
        }
        setNeedsStatusBarAppearanceUpdate()
    }

    private var sheetHeight: CGFloat = 0
    private var sheetChromeAllowance: CGFloat = 0
    private var sheetResolvedDetent: CGFloat = 0
    private var sheetMaxDetent: CGFloat = 0
    private var sheetUpdatingDetent = false

    private func invalidateFitDetent(_ sheet: UISheetPresentationController) {
        sheetUpdatingDetent = true
        sheet.animateChanges { sheet.invalidateDetents() }
        sheetUpdatingDetent = false
    }

    private func reconcileSheetChrome(settled: Bool) {
        guard !sheetUpdatingDetent,
              !isSwappingPushStack,
              let navigation = sheetNavigation,
              let sheet = navigation.sheetPresentationController,
              !sheetIsLarge,
              navigation.view.window != nil,
              app.view.window != nil,
              !navigation.isBeingDismissed else { return }
        if !settled && (navigation.transitionCoordinator != nil || navigation.isBeingPresented) { return }

        let insets = app.view.safeAreaInsets
        if !navigation.isNavigationBarHidden && insets.top < 1 { return }

        let topPadding = max(insets.top, 16)
        let bottomPadding = max(insets.bottom, 16)
        let maxBonus = max(insets.bottom, view.safeAreaInsets.bottom) + 16
        let observedBonus = navigation.view.bounds.height - sheetResolvedDetent
        let bottomBonus: CGFloat
        if sheetResolvedDetent > 0, sheetResolvedDetent < sheetMaxDetent - 0.5, observedBonus >= -0.5, observedBonus <= maxBonus {
            bottomBonus = max(0, observedBonus)
        } else {
            bottomBonus = insets.bottom
        }

        let next = ceil(max(0, topPadding + bottomPadding - bottomBonus))
        guard abs(sheetChromeAllowance - next) > 0.5 else { return }
        sheetChromeAllowance = next
        invalidateFitDetent(sheet)
    }

    func resizeSheet(height: CGFloat) {
        guard let sheet = sheetNavigation?.sheetPresentationController, !sheetIsLarge, abs(sheetHeight - height) > 0.5 else { return }
        sheetHeight = height
        invalidateFitDetent(sheet)
    }

    func dismissSheet(done: @escaping () -> Void) {
        guard let navigation = sheetNavigation else { done(); return }
        navigation.dismiss(animated: true) { [weak self] in
            self?.sheetEnded()
            done()
        }
    }

    func beginSheetPush(done: @escaping (Bool) -> Void) {
        guard let navigation = sheetNavigation, !navigation.isBeingDismissed else { done(false); return }
        if let coordinator = navigation.transitionCoordinator {
            coordinator.animate(alongsideTransition: nil) { [weak self] _ in
                DispatchQueue.main.async { self?.beginSheetPush(done: done) }
            }
            return
        }
        finishSheetPop(animated: false)
        cancelSheetPush()
        guard let pageSnap = app.view.snapshotView(afterScreenUpdates: false) else { done(false); return }
        let cover = navigation.view.snapshotView(afterScreenUpdates: false)
        if let cover = cover {
            cover.frame = navigation.view.bounds
            cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            navigation.view.addSubview(cover)
        }
        preparingPush = PreparingPush(snapshot: pageSnap, previousBar: currentBarSpec, nextBar: nil, cover: cover)
        done(true)
    }

    /// While a push is being prepared, the bar the page sets is the next page's: kept for the commit. False otherwise.
    func holdBarForPush(_ spec: ChromeBarSpec) -> Bool {
        guard preparingPush != nil else { return false }
        preparingPush?.nextBar = spec
        return true
    }

    func commitSheetPush(token: String) -> Bool {
        guard let push = preparingPush,
              let navigation = sheetNavigation,
              !navigation.isBeingDismissed else {
            cancelSheetPush()
            return false
        }
        preparingPush = nil
        let prevBar = push.previousBar
        let nextBar = push.nextBar ?? currentBarSpec

        let prior = navigation.viewControllers.filter { $0 !== app }
        let snapVC = SnapshotViewController(
            snapshot: push.snapshot,
            barSpec: prevBar,
            childToken: token,
            ground: app.view.backgroundColor
        )
        snapVC.navigationItem.backButtonDisplayMode = .minimal
        if let prevBar = prevBar {
            applyBarItem?(prevBar, snapVC.navigationItem, !prior.isEmpty, false)
        }
        pushedTokens.append(token)
        if let nextBar = nextBar {
            currentBarSpec = nextBar
            applyBarItem?(nextBar, app.navigationItem, true, false)
            navigation.setNavigationBarHidden(nextBar.hidden, animated: false)
        }

        // Flush layout after replacing the root stack with the snapshot so UINavigationBar commits the outgoing item
        // before the animated push begins.
        isSwappingPushStack = true
        navigation.setViewControllers(prior + [snapVC], animated: false)
        navigation.view.layoutIfNeeded()
        navigation.navigationBar.layoutIfNeeded()
        CATransaction.flush()
        isSwappingPushStack = false

        push.cover?.removeFromSuperview()
        navigation.pushViewController(app, animated: true)
        return true
    }

    func cancelSheetPush() {
        guard let push = preparingPush else { return }
        preparingPush = nil
        push.cover?.removeFromSuperview()
        if let bar = push.nextBar, let navigation = sheetNavigation {
            currentBarSpec = bar
            applyBarItem?(bar, app.navigationItem, !pushedTokens.isEmpty, false)
            navigation.setNavigationBarHidden(bar.hidden, animated: false)
        }
    }

    func popSheetPage(token: String, animated: Bool, done: @escaping (Bool) -> Void) {
        guard let navigation = sheetNavigation, !navigation.isBeingDismissed else { done(false); return }
        if let coordinator = navigation.transitionCoordinator {
            coordinator.animate(alongsideTransition: nil) { [weak self] _ in
                DispatchQueue.main.async { self?.popSheetPage(token: token, animated: animated, done: done) }
            }
            return
        }
        guard let index = pushedTokens.firstIndex(of: token) else { done(false); return }
        let controllers = navigation.viewControllers
        guard index < controllers.count, let target = controllers[index] as? SnapshotViewController else {
            done(false)
            return
        }
        if !animated {
            let prior = Array(controllers.prefix(index))
            let extraTokens = Array(pushedTokens[(index + 1)...].reversed())
            pushedTokens = Array(pushedTokens.prefix(index))
            if let bar = target.barSpec {
                currentBarSpec = bar
                applyBarItem?(bar, app.navigationItem, !prior.isEmpty, false)
                navigation.setNavigationBarHidden(bar.hidden, animated: false)
            }
            isSwappingPushStack = true
            navigation.setViewControllers(prior + [app], animated: false)
            isSwappingPushStack = false
            if !extraTokens.isEmpty { onPagePopped?(extraTokens) }
            done(true)
            return
        }
        finishSheetPop(animated: false)
        programmaticPop?.done(false)
        programmaticPop = ProgrammaticPop(token: token, done: done)
        navigation.popToViewController(target, animated: true)
    }

    func finishSheetPop(animated: Bool) {
        guard let finishing = finishingPop else { return }
        finishingPop = nil
        finishing.timer.invalidate()
        guard let picture = finishing.cover else { return }
        picture.isUserInteractionEnabled = false
        if animated {
            UIView.animate(withDuration: 0.06, delay: 0, options: [.curveEaseOut, .allowUserInteraction], animations: {
                picture.alpha = 0
            }, completion: { _ in
                picture.removeFromSuperview()
            })
        } else {
            picture.removeFromSuperview()
        }
    }

    func resetPushStack() {
        cancelSheetPush()
        finishSheetPop(animated: false)
        failProgrammaticPop()
        guard !pushedTokens.isEmpty else { return }
        pushedTokens.removeAll()
        guard let navigation = sheetNavigation else { return }
        isSwappingPushStack = true
        navigation.setViewControllers([app], animated: false)
        isSwappingPushStack = false
    }

    private func failProgrammaticPop() {
        guard let pop = programmaticPop else { return }
        programmaticPop = nil
        pop.done(false)
    }

    func navigationController(_ navigationController: UINavigationController, didShow viewController: UIViewController, animated: Bool) {
        guard navigationController === sheetNavigation,
              !isSwappingPushStack,
              let landed = viewController as? SnapshotViewController,
              navigationController.topViewController === landed else { return }

        let controllers = navigationController.viewControllers
        let remainingCount = max(0, controllers.count - 1)
        let priorSnaps = Array(controllers.prefix(remainingCount))
        let poppedTokens = remainingCount < pushedTokens.count
            ? Array(pushedTokens[remainingCount...].reversed())
            : [landed.childToken]
        pushedTokens = Array(pushedTokens.prefix(remainingCount))

        finishingPop?.timer.invalidate()
        finishingPop?.cover?.removeFromSuperview()
        let cover = navigationController.view.snapshotView(afterScreenUpdates: false)
        if let cover = cover {
            cover.frame = navigationController.view.bounds
            cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            navigationController.view.addSubview(cover)
        }
        finishingPop = FinishingPop(cover: cover, timer: Timer.scheduledTimer(withTimeInterval: Self.finishingPopWait, repeats: false) { [weak self] _ in
            self?.finishSheetPop(animated: true)
        })

        if let bar = landed.barSpec {
            currentBarSpec = bar
            applyBarItem?(bar, app.navigationItem, !priorSnaps.isEmpty, false)
            navigationController.setNavigationBarHidden(bar.hidden, animated: false)
        }

        isSwappingPushStack = true
        navigationController.setViewControllers(priorSnaps + [app], animated: false)
        isSwappingPushStack = false

        if let pop = programmaticPop {
            programmaticPop = nil
            let extra = poppedTokens.filter { $0 != pop.token }
            if !extra.isEmpty { onPagePopped?(extra) }
            pop.done(true)
        } else {
            onPagePopped?(poppedTokens)
        }
    }

    /// The sheet is off screen: the web view goes back under the picture of the page, which stays until the page says it
    /// has drawn itself again.
    func sheetEnded() {
        guard let navigation = sheetNavigation else { return }
        cancelSheetPush()
        finishSheetPop(animated: false)
        failProgrammaticPop()
        pushedTokens.removeAll()
        sheetNavigation = nil
        sheetHeight = 0
        sheetChromeAllowance = 0
        sheetResolvedDetent = 0
        sheetMaxDetent = 0
        sheetUpdatingDetent = false
        let barHidden = navigation.isNavigationBarHidden
        if let picture = mainNavigation.viewControllers.first?.view.subviews.first {
            picture.frame = view.bounds
            view.addSubview(picture)
            cover = picture
        }
        navigation.delegate = nil
        isSwappingPushStack = true
        navigation.setViewControllers([], animated: false)
        isSwappingPushStack = false
        mainNavigation.setViewControllers([app], animated: false)
        mainNavigation.setNavigationBarHidden(barHidden, animated: false)
        setNeedsStatusBarAppearanceUpdate()
    }
}

/// The bar and the sheet, as the page asks for them.
@objc(ChromePlugin)
public class ChromePlugin: CAPPlugin, CAPBridgedPlugin, UIAdaptivePresentationControllerDelegate {
    public let identifier = "ChromePlugin"
    public let jsName = "DuskChrome"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "freeze", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "thaw", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentSheet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resizeSheet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismissSheet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginPush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "commitPush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelPush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "popPage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishPop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetPushStack", returnType: CAPPluginReturnPromise)
    ]

    private var pictures: [String: UIImage] = [:]
    private var pendingPictures: Set<String> = []
    /// Found from the scene, not from the web view: between a sheet's dismissal and its return under the bar the web view is in no window.
    private var root: RootViewController? {
        for scene in UIApplication.shared.connectedScenes {
            for window in (scene as? UIWindowScene)?.windows ?? [] {
                if let root = window.rootViewController as? RootViewController {
                    if root.applyBarItem == nil {
                        root.applyBarItem = { [weak self] spec, item, isPushed, animated in
                            self?.applyBar(spec, to: item, isPushed: isPushed, animated: animated)
                        }
                    }
                    if root.onPagePopped == nil {
                        root.onPagePopped = { [weak self] tokens in
                            self?.notifyListeners("pagePopped", data: ["tokens": tokens])
                        }
                    }
                    return root
                }
            }
        }
        return nil
    }

    @objc func info(_ call: CAPPluginCall) {
        // the bar's buttons are glass from iOS 26; before it they would be bare glyphs over the page
        if #available(iOS 26.0, *) { call.resolve(["native": true, "push": true]) } else { call.resolve(["native": false]) }
    }

    /// A page that has just loaded knows of no sheet and no bar: whatever the last one left up comes down.
    @objc func reset(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let root = self.root else { call.resolve(); return }
            let clear = {
                root.resetPushStack()
                root.currentBarSpec = nil
                root.thaw()
                root.app.navigationItem.hidesBackButton = true
                root.app.navigationItem.setLeftBarButtonItems(nil, animated: false)
                root.app.navigationItem.setRightBarButtonItems(nil, animated: false)
                root.app.navigationItem.titleView = nil
                root.app.navigationItem.title = nil
                root.mainNavigation.setNavigationBarHidden(true, animated: false)
                call.resolve()
            }
            if let sheet = root.sheetNavigation {
                sheet.dismiss(animated: false) {
                    root.sheetEnded()
                    clear()
                }
            } else {
                clear()
            }
        }
    }

    @objc func setBar(_ call: CAPPluginCall) {
        let spec = ChromeBarSpec(
            hidden: call.getBool("hidden") ?? false,
            title: call.getString("title"),
            status: call.getString("status"),
            leading: (call.getArray("leading") ?? []).compactMap { $0 as? [String: Any] },
            trailing: (call.getArray("trailing") ?? []).compactMap { $0 as? [String: Any] }
        )
        DispatchQueue.main.async {
            guard let app = self.bridge?.viewController else { call.resolve(); return }
            let root = self.root
            if let root = root, root.holdBarForPush(spec) {
                call.resolve()
                return
            }
            root?.currentBarSpec = spec
            let nav = app.navigationController
            let inSheet = root?.sheetNavigation != nil && nav === root?.sheetNavigation
            let isPushed = inSheet && !(root?.pushedTokens.isEmpty ?? true)
            let wasHidden = nav?.isNavigationBarHidden ?? true
            let suppressAnimation = root?.isFinishingPop == true
            let animateItems = !suppressAnimation && !spec.hidden && !wasHidden
            self.applyBar(spec, to: app.navigationItem, isPushed: isPushed, animated: animateItems)
            if let bar = nav?.navigationBar, wasHidden && !spec.hidden && !suppressAnimation {
                bar.layer.removeAllAnimations()
                nav?.setNavigationBarHidden(false, animated: false)
                bar.alpha = 0
                UIView.animate(withDuration: 0.18, delay: 0, options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction]) {
                    bar.alpha = 1
                }
            } else {
                if let bar = nav?.navigationBar {
                    bar.layer.removeAllAnimations()
                    bar.alpha = 1
                }
                nav?.setNavigationBarHidden(spec.hidden, animated: false)
            }
            call.resolve()
        }
    }

    private func applyBar(_ spec: ChromeBarSpec, to item: UINavigationItem, isPushed: Bool, animated: Bool) {
        item.backButtonDisplayMode = .minimal
        item.title = spec.title
        if let status = spec.status {
            let label = UILabel()
            label.text = status
            label.font = .systemFont(ofSize: 13, weight: .medium)
            label.textColor = .secondaryLabel
            item.titleView = label
        } else {
            item.titleView = nil
        }
        let nativeBack = isPushed && spec.leading.count == 1 && (spec.leading[0]["id"] as? String) == "back"
        if nativeBack {
            item.hidesBackButton = false
            item.setLeftBarButtonItems(nil, animated: animated)
        } else {
            item.hidesBackButton = true
            item.setLeftBarButtonItems(spec.leading.map { self.barItem($0) }, animated: animated)
        }
        item.setRightBarButtonItems(spec.trailing.reversed().map { self.barItem($0) }, animated: animated)
    }

    private func barItem(_ spec: [String: Any]) -> UIBarButtonItem {
        let id = spec["id"] as? String ?? ""
        let press = UIAction { [weak self] _ in self?.notifyListeners("barPress", data: ["id": id]) }
        let symbol = (spec["symbol"] as? String).flatMap { UIImage(systemName: $0) }
        let title = spec["title"] as? String
        let picture = spec["picture"] as? [String: Any]
        let item: UIBarButtonItem
        if spec["role"] as? String == "close" {
            item = UIBarButtonItem(systemItem: .close, primaryAction: press)
        } else if let title = title, picture != nil || symbol != nil {
            var look = UIButton.Configuration.plain()
            look.title = title
            look.image = symbol
            look.imagePadding = 8
            look.baseForegroundColor = .label
            look.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 2, bottom: 0, trailing: 8)
            look.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
                var next = attributes
                next.font = .systemFont(ofSize: 15, weight: .semibold)
                return next
            }
            look.titleLineBreakMode = .byTruncatingTail
            let button = UIButton(configuration: look, primaryAction: press)
            button.widthAnchor.constraint(lessThanOrEqualToConstant: 220).isActive = true
            if let picture = picture { self.fill(button, with: picture) }
            item = UIBarButtonItem(customView: button)
        } else if let picture = picture {
            var look = UIButton.Configuration.plain()
            look.image = symbol
            look.contentInsets = .zero
            let button = UIButton(configuration: look, primaryAction: press)
            button.widthAnchor.constraint(equalToConstant: 32).isActive = true
            button.heightAnchor.constraint(equalToConstant: 32).isActive = true
            self.fill(button, with: picture, side: 32)
            item = UIBarButtonItem(customView: button)
        } else if let title = title {
            item = UIBarButtonItem(title: title, primaryAction: press)
        } else {
            item = UIBarButtonItem(image: symbol, primaryAction: press)
        }
        item.accessibilityLabel = spec["label"] as? String
        item.isEnabled = spec["disabled"] as? Bool != true
        if #available(iOS 26.0, *), let count = spec["badge"] as? Int, count > 0 { item.badge = .count(count) }
        return item
    }

    private static func image(fromDataURL raw: String) -> UIImage? {
        guard raw.hasPrefix("data:image/"), let comma = raw.firstIndex(of: ",") else { return nil }
        let base64 = String(raw[raw.index(after: comma)...])
        guard let bytes = Data(base64Encoded: base64) else { return nil }
        return UIImage(data: bytes)
    }

    private func fill(_ button: UIButton, with picture: [String: Any], side: CGFloat = 30) {
        guard let key = picture["key"] as? String else { return }
        let place = { (image: UIImage) in
            let round = UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
                UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: side, height: side)).addClip()
                let src = image.size
                if src.width > 0 && src.height > 0 {
                    let scale = max(side / src.width, side / src.height)
                    let drawSize = CGSize(width: src.width * scale, height: src.height * scale)
                    let origin = CGPoint(x: (side - drawSize.width) / 2, y: (side - drawSize.height) / 2)
                    image.draw(in: CGRect(origin: origin, size: drawSize))
                } else {
                    image.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
                }
            }
            button.configuration?.image = round.withRenderingMode(.alwaysOriginal)
        }
        if let known = pictures[key] { place(known); return }
        if let dataURL = picture["data"] as? String, let image = Self.image(fromDataURL: dataURL) {
            pictures[key] = image
            place(image)
            notifyListeners("pictureTaken", data: ["key": key])
            return
        }
        if let rawURL = picture["url"] as? String, let url = URL(string: rawURL), url.scheme?.lowercased() == "https" {
            guard !pendingPictures.contains(key) else { return }
            pendingPictures.insert(key)
            URLSession.shared.dataTask(with: url) { [weak self, weak button] data, _, _ in
                let image = data.flatMap(UIImage.init(data:))
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.pendingPictures.remove(key)
                    guard let image = image else { return }
                    self.pictures[key] = image
                    if button != nil { place(image) }
                    self.notifyListeners("pictureTaken", data: ["key": key])
                }
            }.resume()
            return
        }
        guard let x = picture["x"] as? Double, let y = picture["y"] as? Double, let width = picture["width"] as? Double, let height = picture["height"] as? Double,
              width > 0, height > 0, let webView = webView else { return }
        let shot = WKSnapshotConfiguration()
        shot.rect = CGRect(x: x, y: y, width: width, height: height)
        webView.takeSnapshot(with: shot) { [weak self, weak button] image, _ in
            guard let image = image else { return }
            self?.pictures[key] = image
            if button != nil { place(image) }
            self?.notifyListeners("pictureTaken", data: ["key": key])
        }
    }

    @objc func freeze(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.root?.freeze()
            call.resolve()
        }
    }

    @objc func thaw(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.root?.thaw()
            call.resolve()
        }
    }

    @objc func presentSheet(_ call: CAPPluginCall) {
        let height = call.getDouble("height").map { CGFloat($0) }
        DispatchQueue.main.async {
            guard let root = self.root else { call.reject("No root.", "unavailable"); return }
            root.presentSheet(height: height, delegate: self) { call.resolve() }
        }
    }

    @objc func resizeSheet(_ call: CAPPluginCall) {
        let height = CGFloat(call.getDouble("height") ?? 0)
        DispatchQueue.main.async {
            if height > 0 { self.root?.resizeSheet(height: height) }
            call.resolve()
        }
    }

    @objc func dismissSheet(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let root = self.root else { call.resolve(); return }
            root.dismissSheet { call.resolve() }
        }
    }

    @objc func beginPush(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let root = self.root else { call.resolve(["ok": false]); return }
            root.beginSheetPush { ok in call.resolve(["ok": ok]) }
        }
    }

    @objc func commitPush(_ call: CAPPluginCall) {
        let token = call.getString("token") ?? ""
        DispatchQueue.main.async {
            guard !token.isEmpty, let root = self.root else { call.resolve(["ok": false]); return }
            call.resolve(["ok": root.commitSheetPush(token: token)])
        }
    }

    @objc func cancelPush(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.root?.cancelSheetPush()
            call.resolve()
        }
    }

    @objc func popPage(_ call: CAPPluginCall) {
        let token = call.getString("token") ?? ""
        let animated = call.getBool("animated") ?? true
        DispatchQueue.main.async {
            guard !token.isEmpty, let root = self.root else { call.resolve(["popped": false]); return }
            root.popSheetPage(token: token, animated: animated) { popped in call.resolve(["popped": popped]) }
        }
    }

    @objc func finishPop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.root?.finishSheetPop(animated: true)
            call.resolve()
        }
    }

    @objc func resetPushStack(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.root?.resetPushStack()
            call.resolve()
        }
    }

    public func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        root?.sheetEnded()
        notifyListeners("sheetDismissed", data: [:])
    }
}
