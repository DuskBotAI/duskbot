import Capacitor
import UIKit
import WebKit

/// The window's root. The web view's controller sits in a navigation controller, so the page's floating controls are real
/// bar buttons, and a sheet is the same controller presented in a second navigation controller over a picture of the page
/// it left: one web view, the system's own bar, sheet, detents and gestures.
final class RootViewController: UIViewController {
    let app = AppViewController()
    private(set) lazy var mainNavigation = UINavigationController(rootViewController: app)
    private var cover: UIView?
    private(set) var sheetNavigation: UINavigationController?
    private var sheetIsLarge = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
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
        navigation.setNavigationBarHidden(barHidden, animated: false)
        navigation.modalPresentationStyle = .pageSheet
        navigation.presentationController?.delegate = delegate
        if let sheet = navigation.sheetPresentationController {
            sheet.prefersGrabberVisible = true
            sheet.prefersScrollingExpandsWhenScrolledToEdge = false
            if let height = height {
                sheetHeight = height
                sheet.detents = [.custom(identifier: .init("fit")) { [weak self] context in min(self?.sheetHeight ?? height, context.maximumDetentValue) }]
            } else {
                sheet.detents = [.large()]
            }
        }
        sheetIsLarge = height == nil
        sheetNavigation = navigation
        present(navigation, animated: true, completion: shown)
        setNeedsStatusBarAppearanceUpdate()
    }

    private var sheetHeight: CGFloat = 0

    func resizeSheet(height: CGFloat) {
        guard let sheet = sheetNavigation?.sheetPresentationController, !sheetIsLarge, abs(sheetHeight - height) > 0.5 else { return }
        sheetHeight = height
        sheet.animateChanges { sheet.invalidateDetents() }
    }

    func dismissSheet(done: @escaping () -> Void) {
        guard let navigation = sheetNavigation else { done(); return }
        navigation.dismiss(animated: true) { [weak self] in
            self?.sheetEnded()
            done()
        }
    }

    /// The sheet is off screen: the web view goes back under the picture of the page, which stays until the page says it
    /// has drawn itself again.
    func sheetEnded() {
        guard let navigation = sheetNavigation else { return }
        sheetNavigation = nil
        let barHidden = navigation.isNavigationBarHidden
        if let picture = mainNavigation.viewControllers.first?.view.subviews.first {
            picture.frame = view.bounds
            view.addSubview(picture)
            cover = picture
        }
        navigation.setViewControllers([], animated: false)
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
        CAPPluginMethod(name: "dismissSheet", returnType: CAPPluginReturnPromise)
    ]

    private var pictures: [String: UIImage] = [:]
    /// Found from the scene, not from the web view: between a sheet's dismissal and its return under the bar the web view is in no window.
    private var root: RootViewController? {
        for scene in UIApplication.shared.connectedScenes {
            for window in (scene as? UIWindowScene)?.windows ?? [] {
                if let root = window.rootViewController as? RootViewController { return root }
            }
        }
        return nil
    }

    @objc func info(_ call: CAPPluginCall) {
        // the bar's buttons are glass from iOS 26; before it they would be bare glyphs over the page
        if #available(iOS 26.0, *) { call.resolve(["native": true]) } else { call.resolve(["native": false]) }
    }

    /// A page that has just loaded knows of no sheet and no bar: whatever the last one left up comes down.
    @objc func reset(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let root = self.root else { call.resolve(); return }
            let clear = {
                root.thaw()
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
        let hidden = call.getBool("hidden") ?? false
        let title = call.getString("title")
        let status = call.getString("status")
        let leading = (call.getArray("leading") ?? []).compactMap { $0 as? [String: Any] }
        let trailing = (call.getArray("trailing") ?? []).compactMap { $0 as? [String: Any] }
        DispatchQueue.main.async {
            guard let app = self.bridge?.viewController else { call.resolve(); return }
            let item = app.navigationItem
            item.hidesBackButton = true
            item.title = title
            if let status = status {
                let label = UILabel()
                label.text = status
                label.font = .systemFont(ofSize: 13, weight: .medium)
                label.textColor = .secondaryLabel
                item.titleView = label
            } else {
                item.titleView = nil
            }
            let nav = app.navigationController
            let wasHidden = nav?.isNavigationBarHidden ?? true
            let animateItems = !hidden && !wasHidden
            item.setLeftBarButtonItems(leading.map { self.barItem($0) }, animated: animateItems)
            item.setRightBarButtonItems(trailing.reversed().map { self.barItem($0) }, animated: animateItems)
            if let bar = nav?.navigationBar, wasHidden && !hidden {
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
                nav?.setNavigationBarHidden(hidden, animated: false)
            }
            call.resolve()
        }
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

    /// A button's picture is a part of the page (a bot's face is drawn there, by the page's own rules): the page shows it
    /// once at the given frame, and its snapshot is kept under the picture's key.
    private func fill(_ button: UIButton, with picture: [String: Any]) {
        guard let key = picture["key"] as? String else { return }
        let side: CGFloat = 30
        let place = { (image: UIImage) in
            let round = UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
                UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: side, height: side)).addClip()
                image.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
            }
            button.configuration?.image = round.withRenderingMode(.alwaysOriginal)
        }
        if let known = pictures[key] { place(known); return }
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

    public func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        root?.sheetEnded()
        notifyListeners("sheetDismissed", data: [:])
    }
}
