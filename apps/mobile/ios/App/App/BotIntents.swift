import AppIntents
import Foundation

/// A bot as Siri, Spotlight and the Shortcuts app show it.
struct BotEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Bot"
    static var defaultQuery = BotQuery()

    /// the place and the bot's id there, joined by a tab
    let id: String
    let bot: ShortcutBot
    /// set when another linked place has a bot of the same name
    let placeShown: Bool

    var displayRepresentation: DisplayRepresentation {
        placeShown && !bot.placeName.isEmpty
            ? DisplayRepresentation(title: "\(bot.name)", subtitle: "\(bot.placeName)")
            : DisplayRepresentation(title: "\(bot.name)")
    }

    static func all() -> [BotEntity] {
        let bots = ShortcutBots.all()
        let counts = Dictionary(bots.map { ($0.name.lowercased(), 1) }, uniquingKeysWith: +)
        return bots.map { BotEntity(id: "\($0.place)\t\($0.id)", bot: $0, placeShown: (counts[$0.name.lowercased()] ?? 0) > 1) }
    }
}

struct BotQuery: EntityStringQuery {
    func entities(for identifiers: [BotEntity.ID]) async throws -> [BotEntity] {
        let wanted = Set(identifiers)
        return BotEntity.all().filter { wanted.contains($0.id) }
    }

    func entities(matching string: String) async throws -> [BotEntity] {
        let asked = string.trimmingCharacters(in: .whitespacesAndNewlines)
        let all = BotEntity.all()
        guard !asked.isEmpty else { return all }
        return all.filter { $0.bot.name.localizedCaseInsensitiveContains(asked) }
    }

    func suggestedEntities() async throws -> [BotEntity] {
        BotEntity.all()
    }
}

/// Sending needs the page's own connection to the bot's place (as a notification's Reply does), so the app opens and
/// sends it from the bot's chat.
struct SendMessageIntent: AppIntent {
    static var title: LocalizedStringResource = "Send a message"
    static var description = IntentDescription("Sends a message to one of your bots.")
    static var openAppWhenRun = true

    @Parameter(title: "Bot", requestValueDialog: "Which bot?")
    var bot: BotEntity

    @Parameter(title: "Message", inputOptions: String.IntentInputOptions(multiline: true), requestValueDialog: "What's the message?")
    var message: String

    static var parameterSummary: some ParameterSummary {
        Summary("Send \(\.$message) to \(\.$bot)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw $message.needsValueError("What's the message?") }
        ShortcutInbox.shared.post(kind: "send", bot: bot.bot, text: String(text.prefix(8000)))
        return .result()
    }
}

struct StartCallIntent: AppIntent {
    static var title: LocalizedStringResource = "Start a call"
    static var description = IntentDescription("Opens a voice call with one of your bots.")
    static var openAppWhenRun = true

    @Parameter(title: "Bot", requestValueDialog: "Which bot?")
    var bot: BotEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Start a call with \(\.$bot)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        ShortcutInbox.shared.post(kind: "call", bot: bot.bot)
        return .result()
    }
}

struct OpenBotIntent: AppIntent {
    static var title: LocalizedStringResource = "Open a bot"
    static var description = IntentDescription("Opens the chat with one of your bots.")
    static var openAppWhenRun = true

    @Parameter(title: "Bot", requestValueDialog: "Which bot?")
    var bot: BotEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$bot)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        ShortcutInbox.shared.post(kind: "open", bot: bot.bot)
        return .result()
    }
}

/// Apple requires the app's name in every phrase.
struct DuskAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: SendMessageIntent(), phrases: [
            "Send a message to \(\.$bot) in \(.applicationName)",
            "Message \(\.$bot) in \(.applicationName)",
            "Send a message in \(.applicationName)",
        ], shortTitle: "Send a message", systemImageName: "paperplane")
        AppShortcut(intent: StartCallIntent(), phrases: [
            "Start a call with \(\.$bot) in \(.applicationName)",
            "Call \(\.$bot) in \(.applicationName)",
            "Start a call in \(.applicationName)",
        ], shortTitle: "Start a call", systemImageName: "phone")
        AppShortcut(intent: OpenBotIntent(), phrases: [
            "Open \(\.$bot) in \(.applicationName)",
            "Open a bot in \(.applicationName)",
        ], shortTitle: "Open a bot", systemImageName: "bubble.left")
    }
}
