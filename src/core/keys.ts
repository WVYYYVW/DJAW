// Key names as printed on keyboards in each language (German keyboards say "Strg", "Entf"…). Shortcut texts are
// written with the US names ("Ctrl+Shift+Delete") and shown with these.
import { currentLanguage } from './i18n';

const names: Record<string, Record<string, string>> = {
  de: { Ctrl: 'Strg', Shift: 'Umschalt', Delete: 'Entf', Space: 'Leertaste', Home: 'Pos1', End: 'Ende', Enter: 'Eingabe', Esc: 'Esc' },
  fr: { Shift: 'Maj', Delete: 'Suppr', Space: 'Espace', Home: 'Début', End: 'Fin', Enter: 'Entrée', Esc: 'Échap' },
  es: { Shift: 'Mayús', Delete: 'Supr', Space: 'Espacio', Home: 'Inicio', End: 'Fin', Enter: 'Intro', Esc: 'Esc' },
  it: { Shift: 'Maiusc', Delete: 'Canc', Space: 'Spazio', Home: 'Home', End: 'Fine', Enter: 'Invio', Esc: 'Esc' },
  pt: { Space: 'Espaço' },
  ru: { Space: 'Пробел' },
  ko: { Space: 'Space' },
  'zh-Hans': { Space: '空格' },
  'zh-Hant': { Space: '空白鍵' },
};

export function keyCaps(text: string): string {
  const map = names[currentLanguage()];
  return map ? text.replace(/\b(Ctrl|Shift|Delete|Space|Home|End|Enter|Esc)\b/g, k => map[k] ?? k) : text;
}
