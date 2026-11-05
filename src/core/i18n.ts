// UI language (Mac: Model/Localization.swift). "system" follows the OS language (Japanese → 日本語, else English).
export type AppLanguage = 'system' | 'japanese' | 'english';

let english = false;

export function setLanguage(lang: AppLanguage, systemLocale = 'ja') {
  english = lang === 'english' || (lang === 'system' && !systemLocale.toLowerCase().startsWith('ja'));
}

export function isEnglish() {
  return english;
}

/** The Japanese or English variant for the current UI language. */
export function L(japanese: string, englishText: string): string {
  return english ? englishText : japanese;
}
