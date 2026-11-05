import Foundation

/// UI language. "System" follows the Mac's preferred language (Japanese → 日本語, otherwise English).
nonisolated enum AppLanguage: String, CaseIterable, Identifiable, Sendable {
    case system
    case japanese
    case english

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return L("システムに合わせる", "System")
        case .japanese: return "日本語"
        case .english: return "English"
        }
    }

    var isEnglish: Bool {
        switch self {
        case .english: return true
        case .japanese: return false
        case .system:
            let first = Locale.preferredLanguages.first ?? "en"
            return !first.hasPrefix("ja")
        }
    }

    static let defaultsKey = "DJAW.language"

    static var saved: AppLanguage {
        AppLanguage(rawValue: UserDefaults.standard.string(forKey: defaultsKey) ?? "") ?? .system
    }
}

nonisolated enum Lang {
    nonisolated(unsafe) static var isEnglish: Bool = AppLanguage.saved.isEnglish
}

/// Returns the Japanese or English variant for the current UI language.
nonisolated func L(_ japanese: String, _ english: String) -> String {
    Lang.isEnglish ? english : japanese
}
