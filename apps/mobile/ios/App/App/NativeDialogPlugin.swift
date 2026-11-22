import Capacitor
import SwiftUI
import UIKit

/// Native UIKit alerts (`UIAlertController`) and SwiftUI form sheets (`NavigationStack` + `Form`) presented over the
/// topmost view controller (including active sheets) so confirmations and input forms use iOS's own controls.
@objc(NativeDialogPlugin)
public class NativeDialogPlugin: CAPPlugin, CAPBridgedPlugin, UIAdaptivePresentationControllerDelegate {
    public let identifier = "NativeDialogPlugin"
    public let jsName = "DuskDialog"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "alert", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "form", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishForm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismissForm", returnType: CAPPluginReturnPromise)
    ]

    fileprivate enum FieldKind: String {
        case text
        case multiline
        case number
        case password
        case url
    }

    fileprivate struct FieldSpec: Identifiable {
        let id: String
        let label: String
        let initial: String
        let placeholder: String
        let kind: FieldKind
        let required: Bool
        let maxLength: Int?
        let min: Double?
        let max: Double?
        let integer: Bool
        let monospaced: Bool
        let autoFocus: Bool
        let hint: String?
    }

    fileprivate final class FormModel: ObservableObject {
        let fields: [FieldSpec]
        let initialValues: [String: String]
        let requireChange: Bool
        @Published var values: [String: String]
        @Published var saving = false
        @Published var errorMessage: String?

        init(fields: [FieldSpec], requireChange: Bool) {
            self.fields = fields
            self.requireChange = requireChange
            var map: [String: String] = [:]
            for field in fields { map[field.id] = field.initial }
            self.initialValues = map
            self.values = map
        }

        var canSave: Bool {
            if saving { return false }
            for field in fields {
                let raw = values[field.id] ?? ""
                let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                if field.required && trimmed.isEmpty { return false }
                if field.kind == .number, !trimmed.isEmpty {
                    guard let parsed = Double(trimmed), parsed.isFinite else { return false }
                    if field.integer && parsed.rounded() != parsed { return false }
                    if let min = field.min, parsed < min { return false }
                    if let max = field.max, parsed > max { return false }
                }
            }
            if requireChange {
                return fields.contains { (values[$0.id] ?? "") != (initialValues[$0.id] ?? "") }
            }
            return true
        }

        func binding(for field: FieldSpec) -> Binding<String> {
            Binding(
                get: { self.values[field.id] ?? "" },
                set: { next in
                    let clamped = field.maxLength.map { String(next.prefix($0)) } ?? next
                    if self.values[field.id] != clamped {
                        self.values[field.id] = clamped
                    }
                    if self.errorMessage != nil { self.errorMessage = nil }
                }
            )
        }
    }

    fileprivate struct NativeFormView: View {
        let title: String
        let description: String?
        let saveLabel: String
        let cancelLabel: String
        @ObservedObject var model: FormModel
        let onCancel: () -> Void
        let onSubmit: () -> Void
        @FocusState private var focused: String?

        private var singleLineIds: [String] {
            model.fields.filter { $0.kind != .multiline }.map(\.id)
        }

        var body: some View {
            NavigationStack {
                Form {
                    if let error = model.errorMessage, !error.isEmpty {
                        Section {
                            Label(error, systemImage: "exclamationmark.circle.fill")
                                .foregroundStyle(.red)
                                .font(.subheadline)
                        }
                    }
                    if let description, !description.isEmpty {
                        Section {
                            EmptyView()
                        } footer: {
                            Text(description)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    ForEach(model.fields) { field in
                        Section {
                            inputView(for: field)
                        } header: {
                            Text(field.label)
                        } footer: {
                            if let hint = field.hint, !hint.isEmpty {
                                Text(hint)
                            }
                        }
                    }
                }
                .scrollDismissesKeyboard(.interactively)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(cancelLabel, role: .cancel) {
                            onCancel()
                        }
                        .disabled(model.saving)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        if model.saving {
                            ProgressView()
                        } else {
                            Button(saveLabel) {
                                onSubmit()
                            }
                            .fontWeight(.semibold)
                            .disabled(!model.canSave)
                        }
                    }
                }
            }
            .onAppear {
                let target = model.fields.first(where: { $0.autoFocus })?.id ?? model.fields.first?.id
                guard let target else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                    focused = target
                }
            }
        }

        @ViewBuilder
        private func inputView(for field: FieldSpec) -> some View {
            let isLastSingle = singleLineIds.last == field.id && !model.fields.contains(where: { $0.kind == .multiline })
            Group {
                switch field.kind {
                case .multiline:
                    TextField(field.placeholder, text: model.binding(for: field), axis: .vertical)
                        .lineLimit(3...8)
                case .password:
                    SecureField(field.placeholder, text: model.binding(for: field))
                        .submitLabel(isLastSingle ? .done : .next)
                        .onSubmit { advance(from: field.id) }
                case .number:
                    TextField(field.placeholder, text: model.binding(for: field))
                        .keyboardType(.numberPad)
                        .monospacedDigit()
                case .url, .text:
                    HStack(spacing: 8) {
                        TextField(field.placeholder, text: model.binding(for: field))
                            .font(field.kind == .text && field.monospaced ? .system(.body, design: .monospaced) : .body)
                            .keyboardType(field.kind == .url ? .URL : .default)
                            .textInputAutocapitalization(field.kind == .url || field.monospaced ? .never : .sentences)
                            .autocorrectionDisabled(field.kind == .url || field.monospaced)
                            .submitLabel(isLastSingle ? .done : .next)
                            .onSubmit { advance(from: field.id) }
                        clearButton(for: field)
                    }
                }
            }
            .focused($focused, equals: field.id)
            .disabled(model.saving)
        }

        @ViewBuilder
        private func clearButton(for field: FieldSpec) -> some View {
            if focused == field.id, !(model.values[field.id] ?? "").isEmpty, !model.saving {
                Button {
                    model.values[field.id] = ""
                    model.errorMessage = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
            }
        }

        private func advance(from id: String) {
            guard let index = model.fields.firstIndex(where: { $0.id == id }) else { return }
            let nextIndex = model.fields.index(after: index)
            if nextIndex < model.fields.endIndex {
                focused = model.fields[nextIndex].id
            } else if model.canSave {
                onSubmit()
            }
        }
    }

    private final class ActiveForm {
        let id: String
        let call: CAPPluginCall
        let model: FormModel
        let controller: UIHostingController<NativeFormView>
        var resolved = false

        init(id: String, call: CAPPluginCall, model: FormModel, controller: UIHostingController<NativeFormView>) {
            self.id = id
            self.call = call
            self.model = model
            self.controller = controller
        }

        func resolve(_ data: [String: Any]) {
            guard !resolved else { return }
            resolved = true
            call.resolve(data)
        }
    }

    private var activeForm: ActiveForm?

    private func topPresenter() -> UIViewController? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        guard let root = (windows.first(where: { $0.isKeyWindow }) ?? windows.first)?.rootViewController else {
            return bridge?.viewController
        }
        var current = root
        while let presented = current.presentedViewController, !presented.isBeingDismissed {
            current = presented
        }
        return current
    }

    private static func inheritAppearance(_ controller: UIViewController, from presenter: UIViewController) {
        if let style = presenter.view.window?.overrideUserInterfaceStyle, style != .unspecified {
            controller.overrideUserInterfaceStyle = style
        }
    }

    private func presentWhenReady(
        _ build: @escaping (UIViewController) -> UIViewController?,
        onCancel: @escaping () -> Void,
        retries: Int = 4
    ) {
        guard let presenter = topPresenter() else {
            onCancel()
            return
        }
        if let dismissing = presenter.presentedViewController, dismissing.isBeingDismissed {
            guard retries > 0 else { onCancel(); return }
            let retry: () -> Void = { [weak self] in
                DispatchQueue.main.async {
                    self?.presentWhenReady(build, onCancel: onCancel, retries: retries - 1)
                }
            }
            if let coordinator = dismissing.transitionCoordinator {
                coordinator.animate(alongsideTransition: nil) { _ in retry() }
            } else {
                retry()
            }
            return
        }
        guard let controller = build(presenter) else {
            onCancel()
            return
        }
        Self.inheritAppearance(controller, from: presenter)
        presenter.present(controller, animated: true)
    }

    @objc func alert(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let rawMessage = call.getString("message")?.trimmingCharacters(in: .whitespacesAndNewlines)
        let message = (rawMessage?.isEmpty == false) ? rawMessage : nil
        let confirmLabel = call.getString("confirmLabel") ?? "OK"
        let cancelLabel = call.getString("cancelLabel") ?? "Cancel"
        let alternativeLabel = call.getString("alternativeLabel")
        let danger = call.getString("tone") == "danger"
        let singleAction = call.getBool("singleAction") ?? false
        let style: UIAlertController.Style = call.getString("style") == "actionSheet" ? .actionSheet : .alert

        DispatchQueue.main.async {
            var resolved = false
            let finish: (String) -> Void = { outcome in
                guard !resolved else { return }
                resolved = true
                call.resolve(["outcome": outcome])
            }
            self.presentWhenReady({ presenter in
                let alert = UIAlertController(title: title.isEmpty ? nil : title, message: message, preferredStyle: style)
                if !singleAction {
                    alert.addAction(UIAlertAction(title: cancelLabel, style: .cancel) { _ in finish("cancel") })
                }
                if let alternativeLabel, !alternativeLabel.isEmpty {
                    alert.addAction(UIAlertAction(title: alternativeLabel, style: .default) { _ in finish("alternative") })
                }
                let confirm = UIAlertAction(title: confirmLabel, style: danger ? .destructive : .default) { _ in finish("confirm") }
                alert.addAction(confirm)
                if style == .alert && (!danger || singleAction) {
                    alert.preferredAction = confirm
                }
                if style == .actionSheet, let popover = alert.popoverPresentationController {
                    popover.sourceView = presenter.view
                    popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 1, width: 1, height: 1)
                    popover.permittedArrowDirections = []
                }
                return alert
            }, onCancel: { finish("cancel") })
        }
    }

    @objc func form(_ call: CAPPluginCall) {
        let formId = call.getString("id") ?? UUID().uuidString
        let title = call.getString("title") ?? ""
        let description = call.getString("description")
        let saveLabel = call.getString("saveLabel") ?? "Save"
        let cancelLabel = call.getString("cancelLabel") ?? "Cancel"
        let requireChange = call.getBool("requireChange") ?? true
        let asyncSubmit = call.getBool("asyncSubmit") ?? false
        let rawFields = (call.getArray("fields") ?? []).compactMap { $0 as? [String: Any] }
        let fields: [FieldSpec] = rawFields.compactMap { raw in
            guard let id = raw["id"] as? String, let label = raw["label"] as? String else { return nil }
            let kind = (raw["kind"] as? String).flatMap(FieldKind.init(rawValue:)) ?? .text
            return FieldSpec(
                id: id,
                label: label,
                initial: raw["value"] as? String ?? "",
                placeholder: raw["placeholder"] as? String ?? "",
                kind: kind,
                required: raw["required"] as? Bool ?? false,
                maxLength: (raw["maxLength"] as? NSNumber)?.intValue,
                min: (raw["min"] as? NSNumber)?.doubleValue,
                max: (raw["max"] as? NSNumber)?.doubleValue,
                integer: raw["integer"] as? Bool ?? false,
                monospaced: raw["monospaced"] as? Bool ?? false,
                autoFocus: raw["autoFocus"] as? Bool ?? false,
                hint: raw["hint"] as? String
            )
        }
        guard !fields.isEmpty else {
            call.reject("A form needs at least one field.", "invalid")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve(["saved": false])
                return
            }
            let presentNewForm: () -> Void = { [weak self] in
                guard let self else {
                    call.resolve(["saved": false])
                    return
                }
                let model = FormModel(fields: fields, requireChange: requireChange)
                weak var activeRef: ActiveForm?

                let cancel: () -> Void = { [weak self] in
                    guard let self, let active = activeRef, !active.model.saving else { return }
                    if self.activeForm === active { self.activeForm = nil }
                    active.controller.dismiss(animated: true) {
                        active.resolve(["saved": false])
                    }
                }

                let submit: () -> Void = { [weak self] in
                    guard let self, let active = activeRef, active.model.canSave else { return }
                    let snapshot = active.model.values
                    if !asyncSubmit {
                        if self.activeForm === active { self.activeForm = nil }
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                        active.controller.dismiss(animated: true) {
                            active.resolve(["saved": true, "values": snapshot])
                        }
                        return
                    }
                    active.model.saving = true
                    active.model.errorMessage = nil
                    active.controller.isModalInPresentation = true
                    self.notifyListeners("formSubmit", data: ["id": active.id, "values": snapshot])
                }

                let view = NativeFormView(
                    title: title,
                    description: description,
                    saveLabel: saveLabel,
                    cancelLabel: cancelLabel,
                    model: model,
                    onCancel: cancel,
                    onSubmit: submit
                )
                self.presentWhenReady({ _ in
                    let hosting = UIHostingController(rootView: view)
                    hosting.modalPresentationStyle = .pageSheet
                    hosting.presentationController?.delegate = self
                    if let sheet = hosting.sheetPresentationController {
                        let largeOnly = fields.count >= 2 || fields.contains(where: { $0.kind == .multiline })
                        sheet.detents = largeOnly ? [.large()] : [.medium(), .large()]
                        sheet.prefersGrabberVisible = true
                        sheet.prefersScrollingExpandsWhenScrolledToEdge = true
                    }
                    let active = ActiveForm(id: formId, call: call, model: model, controller: hosting)
                    activeRef = active
                    self.activeForm = active
                    return hosting
                }, onCancel: {
                    call.resolve(["saved": false])
                })
            }

            if let existing = self.activeForm {
                self.activeForm = nil
                existing.controller.dismiss(animated: false) {
                    existing.resolve(["saved": false])
                    presentNewForm()
                }
            } else {
                presentNewForm()
            }
        }
    }

    @objc func finishForm(_ call: CAPPluginCall) {
        let formId = call.getString("id") ?? ""
        let ok = call.getBool("ok") ?? false
        let error = call.getString("error")
        DispatchQueue.main.async {
            guard let active = self.activeForm, active.id == formId else {
                call.resolve()
                return
            }
            if ok {
                let snapshot = active.model.values
                self.activeForm = nil
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                active.controller.dismiss(animated: true) {
                    active.resolve(["saved": true, "values": snapshot])
                    call.resolve()
                }
            } else {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                active.model.saving = false
                active.model.errorMessage = error ?? "Could not save changes."
                active.controller.isModalInPresentation = false
                call.resolve()
            }
        }
    }

    @objc func dismissForm(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let active = self.activeForm else {
                call.resolve()
                return
            }
            self.activeForm = nil
            active.controller.dismiss(animated: true) {
                active.resolve(["saved": false])
                call.resolve()
            }
        }
    }

    public func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard let active = activeForm, active.controller === presentationController.presentedViewController else { return }
        activeForm = nil
        active.resolve(["saved": false])
    }
}
