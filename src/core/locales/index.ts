// The translation tables (keyed by the English text; see core/i18n.ts and scripts/i18n.mjs). Imported once by each
// process that shows text: the main process (menus, dialogs), the renderer and the analysis process.
import { registerLanguage } from '../i18n';
import zhHans from './zh-Hans.json';
import zhHant from './zh-Hant.json';
import ko from './ko.json';
import es from './es.json';
import fr from './fr.json';
import de from './de.json';
import it from './it.json';
import pt from './pt.json';
import ru from './ru.json';

const all: Record<string, Record<string, string>> = { 'zh-Hans': zhHans, 'zh-Hant': zhHant, ko, es, fr, de, it, pt, ru };
for (const [id, t] of Object.entries(all)) registerLanguage(id, t);
