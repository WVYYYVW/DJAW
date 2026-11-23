// Names DJAW gives things by itself (a cue, a take, a folder, a sampler sound…). They are stored with the mix in
// the language of the moment, so they are shown again in the language in effect — unless the user renamed them.
import { L, inEveryLanguage, localize, reLocalize } from './i18n';
import { builtinByFile } from './builtinSamples';

export const DefaultName = {
  cue: (n: number | string) => L(`CUE ${n}`, `Cue ${n}`),
  take: (n: number | string) => L(`候補 ${n}`, `Take ${n}`),
  previousTake: () => L('前のつなぎ（自動保存）', 'Previous (auto-saved)'),
  myTransition: (n: number | string) => L(`マイつなぎ ${n}`, `My Transition ${n}`),
  folder: () => L('新しいフォルダ', 'New Folder'),
};

const isDefault = (stored: string, make: () => string) => inEveryLanguage(make).includes(stored);

export const ShownName = {
  cue: (label: string) => reLocalize(label, n => DefaultName.cue(n)),
  take: (name: string) => {
    const t = localize(name);
    return isDefault(t, DefaultName.previousTake) ? DefaultName.previousTake() : reLocalize(t, n => DefaultName.take(n));
  },
  myTransition: (name: string) => reLocalize(name, n => DefaultName.myTransition(n)),
  folder: (name: string) => isDefault(name, DefaultName.folder) ? DefaultName.folder()
    : reLocalize(name, n => `${DefaultName.folder()} ${n}`),
  /** A built-in sampler sound that still has its own name (from any version, in any language) shows today's name. */
  sample: (file: string | null, name: string) => {
    const b = file ? builtinByFile(file) : null;
    return b && (isDefault(name, b.title) || (b.oldNames ?? []).includes(name)) ? b.title() : name;
  },
};
