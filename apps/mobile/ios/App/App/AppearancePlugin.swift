import Capacitor
import UIKit

/// The app's own look, told to the system: its menus, keyboard and sheets follow the window's interface style, which
/// otherwise stays the phone's even when the app is set to the other one.
@objc(AppearancePlugin)
public class AppearancePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppearancePlugin"
    public let jsName = "DuskAppearance"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise)
    ]

    @objc func set(_ call: CAPPluginCall) {
        let style: UIUserInterfaceStyle
        switch call.getString("scheme") {
        case "dark": style = .dark
        case "light": style = .light
        default: style = .unspecified
        }
        DispatchQueue.main.async {
            self.bridge?.viewController?.view.window?.overrideUserInterfaceStyle = style
            call.resolve()
        }
    }
}

/// Native pasteboard access so async UIMenu actions ("Paste from phone") can read the clipboard without WKWebView's
/// synchronous user-gesture restriction.
@objc(ClipboardPlugin)
public class ClipboardPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ClipboardPlugin"
    public let jsName = "DuskClipboard"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
    ]

    @objc func read(_ call: CAPPluginCall) {
        // UIPasteboard.general.string blocks synchronously if iOS prompts for paste authorization; keep off the main thread.
        DispatchQueue.global(qos: .userInitiated).async {
            if let text = UIPasteboard.general.string {
                call.resolve(["text": text])
            } else {
                call.resolve([:])
            }
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        DispatchQueue.main.async {
            UIPasteboard.general.string = text
            call.resolve()
        }
    }
}
