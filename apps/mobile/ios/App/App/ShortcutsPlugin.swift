import Capacitor
import Foundation

/// One bot the page last listed for a place.
struct ShortcutBot: Codable, Hashable {
    let place: String
    let placeName: String
    let id: String
    let name: String
}

/// The bots Siri, Spotlight and the Shortcuts app offer, as the page last listed them per place, in the app's own
/// defaults: the intents run in the app's process, so no app group is needed.
enum ShortcutBots {
    private static let key = "dusk.shortcuts.bots.v1"
    private struct Place: Codable { let name: String; let bots: [Bot] }
    private struct Bot: Codable { let id: String; let name: String }

    static func all() -> [ShortcutBot] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let places = try? JSONDecoder().decode([String: Place].self, from: data) else { return [] }
        return places.sorted { $0.key < $1.key }.flatMap { place, saved in
            saved.bots.map { ShortcutBot(place: place, placeName: saved.name, id: $0.id, name: $0.name) }
        }
    }

    /// `bots` for `place`; places not in `kept` (removed from the phone) are forgotten.
    static func save(place: String, placeName: String, bots: [(id: String, name: String)], kept: Set<String>) {
        var places: [String: Place] = [:]
        if let data = UserDefaults.standard.data(forKey: key), let saved = try? JSONDecoder().decode([String: Place].self, from: data) {
            places = saved.filter { kept.contains($0.key) }
        }
        places[place] = Place(name: placeName, bots: bots.map { Bot(id: $0.id, name: $0.name) })
        if let data = try? JSONEncoder().encode(places) { UserDefaults.standard.set(data, forKey: key) }
    }

    static func forget() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}

/// Shortcut runs waiting for the page: an intent can run before the page has loaded (a cold launch), so each waits
/// here until the page takes it.
@MainActor
final class ShortcutInbox {
    static let shared = ShortcutInbox()
    nonisolated static let arrived = Notification.Name("DuskShortcutArrived")
    private var waiting: [JSObject] = []

    func post(kind: String, bot: ShortcutBot, text: String? = nil) {
        var action: JSObject = ["kind": kind, "place": bot.place, "botId": bot.id]
        if let text { action["text"] = text }
        waiting.append(action)
        NotificationCenter.default.post(name: Self.arrived, object: nil)
    }

    func take() -> [JSObject] {
        defer { waiting.removeAll() }
        return waiting
    }
}

@objc(ShortcutsPlugin)
public class ShortcutsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShortcutsPlugin"
    public let jsName = "DuskShortcuts"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setBots", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
    ]
    private var observer: NSObjectProtocol?

    override public func load() {
        observer = NotificationCenter.default.addObserver(forName: ShortcutInbox.arrived, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("arrived", data: [:])
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    @objc func setBots(_ call: CAPPluginCall) {
        guard let place = call.getString("place"), !place.isEmpty else { return call.reject("place is required") }
        let placeName = call.getString("placeName") ?? ""
        let bots: [(id: String, name: String)] = (call.getArray("bots") ?? []).compactMap { item in
            guard let bot = item as? JSObject, let id = bot["id"] as? String, let name = bot["name"] as? String, !id.isEmpty, !name.isEmpty else { return nil }
            return (id, name)
        }
        let kept = Set((call.getArray("places") ?? []).compactMap { $0 as? String })
        ShortcutBots.save(place: place, placeName: placeName, bots: bots, kept: kept.union([place]))
        DuskAppShortcuts.updateAppShortcutParameters()
        call.resolve()
    }

    @objc func forget(_ call: CAPPluginCall) {
        ShortcutBots.forget()
        DuskAppShortcuts.updateAppShortcutParameters()
        call.resolve()
    }

    @objc func take(_ call: CAPPluginCall) {
        Task { @MainActor in
            call.resolve(["actions": ShortcutInbox.shared.take()])
        }
    }
}
