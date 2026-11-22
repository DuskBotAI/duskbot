import Capacitor
import UIKit
import WebKit

enum MainSheetFreeze {
    case none
    case active
    case thawing
}

struct ChromeSearchSpec: Equatable {
    let key: String
    let placeholder: String
    let value: String?
    let autoFocus: Bool
}

struct ChromeBarSpec {
    let hidden: Bool
    let title: String?
    let status: String?
    let leading: [[String: Any]]
    let trailing: [[String: Any]]
    let search: ChromeSearchSpec?
}

/// Permanent root of `mainNavigation` so its `UINavigationBar` and main-screen Liquid Glass layers stay live behind a
/// presented sheet instead of being frozen mid-animation into a bitmap snapshot.
final class MainHostViewController: UIViewController {
    let glassHost = PassthroughView()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        glassHost.frame = view.bounds
        glassHost.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(glassHost)
    }

    func attach(_ app: AppViewController) {
        loadViewIfNeeded()
        if app.parent !== self {
            addChild(app)
            app.view.frame = view.bounds
            app.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.insertSubview(app.view, at: 0)
            app.didMove(toParent: self)
        } else if app.view.superview !== view {
            app.view.frame = view.bounds
            view.insertSubview(app.view, at: 0)
        }
    }

    func detach(_ app: AppViewController) {
        guard app.parent === self else { return }
        app.willMove(toParent: nil)
        app.view.removeFromSuperview()
        app.removeFromParent()
    }
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
    let mainHost = MainHostViewController()
    private(set) lazy var mainNavigation = UINavigationController(rootViewController: mainHost)
    private var cover: UIView?
    private(set) var sheetNavigation: UINavigationController?
    private var sheetIsLarge = false
    private var preparingSheet = false
    private var heldSheetBarSpec: ChromeBarSpec?
    private var hasMainBarContent = false
    private static let mainBarSlideKeys = ["main-bar-slide", "main-bar-alpha"]
    private static let mainBarParallax: CGFloat = 24

    var currentBarSpec: ChromeBarSpec?
    var applyBarItem: ((ChromeBarSpec, UINavigationItem, Bool, Bool) -> Void)?
    var onPagePopped: (([String]) -> Void)?
    var onSheetCleanup: (() -> Void)?
    var onMainBarApply: ((ChromeBarSpec) -> Void)?

    private(set) var pushedTokens: [String] = []
    var isCovered: Bool { cover != nil }

    private var glassPlugin: GlassChromePlugin? {
        (app.bridge?.plugin(withName: "DuskGlass") ?? app.bridge?.plugin(withName: "GlassChromePlugin")) as? GlassChromePlugin
    }

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
        mainHost.attach(app)
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

    func markMainBarContent(_ hasContent: Bool) {
        hasMainBarContent = hasContent
        if !hasContent { resetMainBarMotion() }
    }

    private func mainBarShift(_ page: CGFloat, width: CGFloat) -> CGFloat {
        let progress = min(1, max(0, page / max(1, width)))
        return -Self.mainBarParallax * (1 - progress)
    }

    private func mainBarAlpha(_ page: CGFloat, width: CGFloat) -> CGFloat {
        let progress = min(1, max(0, page / max(1, width)))
        return max(0, min(1, (progress - 0.42) / 0.58))
    }

    private var mainBarSlideGen = 0

    func resetMainBarMotion() {
        mainBarSlideGen += 1
        let bar = mainNavigation.navigationBar
        for key in Self.mainBarSlideKeys {
            bar.layer.removeAnimation(forKey: key)
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        bar.transform = .identity
        bar.alpha = 1
        CATransaction.commit()
    }

    var isMainBarSliding: Bool {
        let keys = mainNavigation.navigationBar.layer.animationKeys() ?? []
        return Self.mainBarSlideKeys.contains(where: keys.contains)
    }

    /// Cross-fades and glides `mainNavigation.navigationBar` in lockstep with a chat page dragging across the screen.
    /// Avoids `CALayer.mask` (which hides iOS 26 Liquid Glass navigation bars) and starts revealing only after the chat
    /// header has faded out past ~42% drag so the two glass bars never collide.
    func followMainBar(page: CGFloat?) {
        guard hasMainBarContent, sheetNavigation == nil, !preparingSheet else { return }
        let bar = mainNavigation.navigationBar
        let width = max(1, mainNavigation.view.bounds.width)
        guard let page else {
            resetMainBarMotion()
            return
        }
        let x = min(max(0, page), width)
        if x <= 0.5 {
            resetMainBarMotion()
            if !mainNavigation.isNavigationBarHidden {
                mainNavigation.setNavigationBarHidden(true, animated: false)
            }
            return
        }
        if x >= width - 0.5 {
            if mainNavigation.isNavigationBarHidden {
                mainNavigation.setNavigationBarHidden(false, animated: false)
            }
            resetMainBarMotion()
            return
        }
        mainBarSlideGen += 1
        if mainNavigation.isNavigationBarHidden {
            mainNavigation.setNavigationBarHidden(false, animated: false)
            mainNavigation.view.layoutIfNeeded()
        }
        for key in Self.mainBarSlideKeys {
            bar.layer.removeAnimation(forKey: key)
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        bar.transform = CGAffineTransform(translationX: mainBarShift(x, width: width), y: 0)
        bar.alpha = mainBarAlpha(x, width: width)
        CATransaction.commit()
    }

    /// Plays `mainNavigation.navigationBar`'s parallax and cross-fade in the same CoreAnimation transaction as a chat
    /// push or pop slide.
    func slideMainBar(_ points: [CGFloat], duration: TimeInterval, beginTime: CFTimeInterval) {
        guard hasMainBarContent, sheetNavigation == nil, !preparingSheet, let last = points.last else { return }
        let bar = mainNavigation.navigationBar
        let width = max(1, mainNavigation.view.bounds.width)
        let pages = points.map { min(max(0, $0), width) }
        if pages.allSatisfy({ $0 <= 0.5 }) {
            followMainBar(page: 0)
            return
        }
        if mainNavigation.isNavigationBarHidden {
            mainNavigation.setNavigationBarHidden(false, animated: false)
            mainNavigation.view.layoutIfNeeded()
        }
        mainBarSlideGen += 1
        let gen = mainBarSlideGen
        let finalX = min(max(0, last), width)
        let move = CAKeyframeAnimation.pageSlide(keyPath: "transform.translation.x", values: pages.map { mainBarShift($0, width: width) }, duration: duration, beginTime: beginTime)
        let fade = CAKeyframeAnimation.pageSlide(keyPath: "opacity", values: pages.map { mainBarAlpha($0, width: width) }, duration: duration, beginTime: beginTime)
        CATransaction.begin()
        if finalX <= 0.5 {
            CATransaction.setCompletionBlock { [weak self] in
                guard let self, self.mainBarSlideGen == gen, self.sheetNavigation == nil, !self.preparingSheet else { return }
                self.resetMainBarMotion()
                if !self.mainNavigation.isNavigationBarHidden {
                    self.mainNavigation.setNavigationBarHidden(true, animated: false)
                }
            }
        }
        for (animation, key) in [(move, Self.mainBarSlideKeys[0]), (fade, Self.mainBarSlideKeys[1])] {
            bar.layer.removeAnimation(forKey: key)
            bar.layer.add(animation, forKey: key)
        }
        bar.transform = CGAffineTransform(translationX: mainBarShift(finalX, width: width), y: 0)
        bar.alpha = mainBarAlpha(finalX, width: width)
        CATransaction.commit()
    }

    /// Holds the sheet's incoming bar spec between `freeze()` and `presentSheet()` so `mainNavigation.navigationBar`
    /// keeps the presenting screen's live Liquid Glass bar items untouched while their release animation completes.
    func holdBarForSheet(_ spec: ChromeBarSpec) -> Bool {
        guard preparingSheet else { return false }
        heldSheetBarSpec = spec
        return true
    }

    private func installFreezeCover() -> Bool {
        guard cover == nil, let picture = app.view.snapshotView(afterScreenUpdates: false) else { return cover != nil }
        mainHost.view.backgroundColor = app.view.backgroundColor
        picture.frame = mainHost.view.bounds
        picture.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        mainHost.view.insertSubview(picture, belowSubview: mainHost.glassHost)
        cover = picture
        return true
    }

    /// Snapshots `app.view` underneath `mainHost.glassHost` and `mainNavigation.navigationBar` so native Liquid Glass
    /// buttons stay live and complete their press-release spring animations while the sheet prepares and rises.
    func freeze() {
        guard cover == nil, sheetNavigation == nil, installFreezeCover() else { return }
        preparingSheet = true
        glassPlugin?.setMainSheetFreeze(.active)
    }

    func thaw() {
        let abortedPrepare = preparingSheet && sheetNavigation == nil
        preparingSheet = false
        let pendingMainBar = abortedPrepare ? heldSheetBarSpec : nil
        if abortedPrepare { heldSheetBarSpec = nil }
        if let pendingMainBar { onMainBarApply?(pendingMainBar) }
        glassPlugin?.setMainSheetFreeze(.none)
        guard let picture = cover else { return }
        cover = nil
        UIView.animate(withDuration: 0.14, animations: { picture.alpha = 0 }, completion: { _ in picture.removeFromSuperview() })
    }

    func presentSheet(height: CGFloat?, delegate: UIAdaptivePresentationControllerDelegate, shown: @escaping () -> Void) {
        guard sheetNavigation == nil else { shown(); return }
        preparingSheet = false
        _ = installFreezeCover()
        glassPlugin?.setMainSheetFreeze(.active)
        mainHost.detach(app)

        let sheetBar = heldSheetBarSpec
        heldSheetBarSpec = nil
        let barHidden = sheetBar?.hidden ?? true
        let navigation = UINavigationController(rootViewController: app)
        navigation.delegate = self
        if let sheetBar {
            currentBarSpec = sheetBar
            applyBarItem?(sheetBar, app.navigationItem, false, false)
        }
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

    /// The sheet is off screen: the web view returns underneath `cover` and the live main-screen glass chrome until the
    /// page finishes unmounting the sheet and calls `thaw()`.
    func sheetEnded() {
        guard let navigation = sheetNavigation else { return }
        cancelSheetPush()
        finishSheetPop(animated: false)
        failProgrammaticPop()
        pushedTokens.removeAll()
        sheetNavigation = nil
        currentBarSpec = nil
        heldSheetBarSpec = nil
        sheetHeight = 0
        sheetChromeAllowance = 0
        sheetResolvedDetent = 0
        sheetMaxDetent = 0
        sheetUpdatingDetent = false
        navigation.delegate = nil
        isSwappingPushStack = true
        navigation.setViewControllers([], animated: false)
        isSwappingPushStack = false
        onSheetCleanup?()
        mainHost.attach(app)
        glassPlugin?.setMainSheetFreeze(.thawing)
        setNeedsStatusBarAppearanceUpdate()
    }
}

/// The bar and the sheet, as the page asks for them.
@objc(ChromePlugin)
public class ChromePlugin: CAPPlugin, CAPBridgedPlugin, UIAdaptivePresentationControllerDelegate, UISearchResultsUpdating, UISearchBarDelegate {
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

    private struct BarItemSignature: Equatable {
        let id: String
        let symbol: String?
        let title: String?
        let role: String?
        let label: String?
        let disabled: Bool
        let badge: Int
        let pictureKey: String?
        let pictureLoaded: Bool
    }

    private struct BarSignature: Equatable {
        let hidden: Bool
        let title: String?
        let status: String?
        let leading: [BarItemSignature]
        let trailing: [BarItemSignature]
        let search: ChromeSearchSpec?
    }

    private var pictures: [String: UIImage] = [:]
    private var pendingPictures: Set<String> = []
    private var mainBarSignature: BarSignature?
    private var searchController: UISearchController?
    private var activeSearchKey: String?
    private var lastSearchText: String?
    private var pendingSearchFocus = false
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
                    if root.onSheetCleanup == nil {
                        root.onSheetCleanup = { [weak self, weak root] in
                            guard let self, let root else { return }
                            self.clearNavigationItem(root.app.navigationItem)
                        }
                    }
                    if root.onMainBarApply == nil {
                        root.onMainBarApply = { [weak self, weak root] spec in
                            guard let self, let root else { return }
                            self.applyMainBar(spec, on: root)
                        }
                    }
                    return root
                }
            }
        }
        return nil
    }

    private func signature(for spec: ChromeBarSpec) -> BarSignature {
        func itemSig(_ raw: [String: Any]) -> BarItemSignature {
            let picture = raw["picture"] as? [String: Any]
            let key = picture?["key"] as? String
            return BarItemSignature(
                id: raw["id"] as? String ?? "",
                symbol: raw["symbol"] as? String,
                title: raw["title"] as? String,
                role: raw["role"] as? String,
                label: raw["label"] as? String,
                disabled: raw["disabled"] as? Bool == true,
                badge: raw["badge"] as? Int ?? 0,
                pictureKey: key,
                pictureLoaded: key.map { pictures[$0] != nil } ?? false
            )
        }
        return BarSignature(
            hidden: spec.hidden,
            title: spec.title,
            status: spec.status,
            leading: spec.leading.map(itemSig),
            trailing: spec.trailing.map(itemSig),
            search: spec.search
        )
    }

    private func clearNavigationItem(_ item: UINavigationItem) {
        item.hidesBackButton = true
        item.setLeftBarButtonItems(nil, animated: false)
        item.setRightBarButtonItems(nil, animated: false)
        item.titleView = nil
        item.title = nil
        detachSearch(from: item)
    }

    private func applyMainBar(_ spec: ChromeBarSpec, on root: RootViewController) {
        let nav = root.mainNavigation
        let nextSignature = signature(for: spec)
        if spec.hidden {
            if !nav.isNavigationBarHidden {
                root.resetMainBarMotion()
                nav.setNavigationBarHidden(true, animated: false)
            }
            return
        }
        let itemsUnchanged = mainBarSignature == nextSignature
        if itemsUnchanged && !nav.isNavigationBarHidden {
            return
        }
        let wasHidden = nav.isNavigationBarHidden
        let suppressAnimation = root.isCovered
        if !itemsUnchanged {
            let animateItems = !suppressAnimation && !wasHidden
            applyBar(spec, to: root.mainHost.navigationItem, isPushed: false, animated: animateItems)
            mainBarSignature = signature(for: spec)
        }
        root.markMainBarContent(!spec.leading.isEmpty || !spec.trailing.isEmpty || spec.title != nil || spec.status != nil)
        let bar = nav.navigationBar
        if wasHidden && !suppressAnimation {
            root.resetMainBarMotion()
            nav.setNavigationBarHidden(false, animated: false)
            bar.alpha = 0
            UIView.animate(withDuration: 0.18, delay: 0, options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction]) {
                bar.alpha = 1
            }
        } else {
            if !root.isMainBarSliding {
                root.resetMainBarMotion()
            }
            nav.setNavigationBarHidden(false, animated: false)
        }
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
                self.mainBarSignature = nil
                root.markMainBarContent(false)
                root.thaw()
                self.clearNavigationItem(root.app.navigationItem)
                self.clearNavigationItem(root.mainHost.navigationItem)
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
        let searchObj = call.getObject("search")
        let search: ChromeSearchSpec? = searchObj.flatMap { raw in
            guard let key = raw["key"] as? String else { return nil }
            return ChromeSearchSpec(
                key: key,
                placeholder: raw["placeholder"] as? String ?? "",
                value: raw["value"] as? String,
                autoFocus: raw["autoFocus"] as? Bool ?? false
            )
        }
        let spec = ChromeBarSpec(
            hidden: call.getBool("hidden") ?? false,
            title: call.getString("title"),
            status: call.getString("status"),
            leading: (call.getArray("leading") ?? []).compactMap { $0 as? [String: Any] },
            trailing: (call.getArray("trailing") ?? []).compactMap { $0 as? [String: Any] },
            search: search
        )
        DispatchQueue.main.async {
            guard let app = self.bridge?.viewController else { call.resolve(); return }
            let root = self.root
            if let root = root, root.holdBarForPush(spec) {
                call.resolve()
                return
            }
            if let root = root, root.holdBarForSheet(spec) {
                call.resolve()
                return
            }
            if let root = root, root.sheetNavigation == nil {
                self.applyMainBar(spec, on: root)
                call.resolve()
                return
            }
            root?.currentBarSpec = spec
            let nav = root?.sheetNavigation ?? app.navigationController
            let isPushed = root?.sheetNavigation != nil && !(root?.pushedTokens.isEmpty ?? true)
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
        if let app = bridge?.viewController, item === app.navigationItem {
            applySearch(spec.search, to: app)
        }
    }

    private func applySearch(_ search: ChromeSearchSpec?, to controller: UIViewController) {
        guard let search else {
            detachSearch(from: controller.navigationItem)
            return
        }
        controller.definesPresentationContext = true
        let sc: UISearchController
        if let existing = searchController {
            sc = existing
        } else {
            sc = UISearchController(searchResultsController: nil)
            sc.obscuresBackgroundDuringPresentation = false
            sc.hidesNavigationBarDuringPresentation = false
            sc.automaticallyShowsCancelButton = true
            sc.searchResultsUpdater = self
            sc.searchBar.delegate = self
            searchController = sc
        }
        if sc.searchBar.placeholder != search.placeholder {
            sc.searchBar.placeholder = search.placeholder
        }
        if controller.navigationItem.searchController !== sc {
            controller.navigationItem.searchController = sc
            controller.navigationItem.hidesSearchBarWhenScrolling = false
        }
        if activeSearchKey != search.key {
            activeSearchKey = search.key
            let initial = search.value ?? ""
            lastSearchText = initial
            sc.searchBar.text = initial
            pendingSearchFocus = search.autoFocus
            if search.autoFocus, controller.view.window != nil, root?.sheetNavigation?.isBeingPresented != true {
                focusSearchBar()
            }
        } else if let value = search.value, value != sc.searchBar.text {
            lastSearchText = value
            sc.searchBar.text = value
        }
    }

    private func detachSearch(from item: UINavigationItem) {
        activeSearchKey = nil
        lastSearchText = nil
        pendingSearchFocus = false
        if let sc = searchController {
            if sc.isActive { sc.isActive = false }
            sc.searchBar.resignFirstResponder()
        }
        if item.searchController != nil {
            item.searchController = nil
        }
    }

    private func focusSearchBar() {
        guard pendingSearchFocus, let sc = searchController else { return }
        pendingSearchFocus = false
        DispatchQueue.main.async {
            sc.searchBar.becomeFirstResponder()
        }
    }

    public func updateSearchResults(for searchController: UISearchController) {
        guard activeSearchKey != nil else { return }
        let text = searchController.searchBar.text ?? ""
        guard text != lastSearchText else { return }
        lastSearchText = text
        notifyListeners("searchChange", data: ["text": text])
    }

    public func searchBarCancelButtonClicked(_ searchBar: UISearchBar) {
        guard activeSearchKey != nil else { return }
        notifyListeners("searchCancel", data: [:])
    }

    private func barItem(_ spec: [String: Any]) -> UIBarButtonItem {
        let id = spec["id"] as? String ?? ""
        let press = UIAction { [weak self] _ in self?.notifyListeners("barPress", data: ["id": id]) }
        let symbol = (spec["symbol"] as? String).flatMap { UIImage(systemName: $0) }
        let title = spec["title"] as? String
        let role = spec["role"] as? String
        let picture = spec["picture"] as? [String: Any]
        let item: UIBarButtonItem
        if role == "close" {
            item = UIBarButtonItem(systemItem: .close, primaryAction: press)
        } else if role == "cancel" {
            if let title = title {
                item = UIBarButtonItem(title: title, primaryAction: press)
            } else {
                item = UIBarButtonItem(systemItem: .cancel, primaryAction: press)
            }
        } else if role == "done" || role == "confirm" {
            if let title = title {
                item = UIBarButtonItem(title: title, primaryAction: press)
            } else {
                item = UIBarButtonItem(systemItem: .done, primaryAction: press)
            }
            if #available(iOS 26.0, *) { item.style = .prominent } else { item.style = .done }
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
        UIImage.fromDataURL(raw)
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
            root.presentSheet(height: height, delegate: self) {
                self.focusSearchBar()
                call.resolve()
            }
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
