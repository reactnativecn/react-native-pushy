import enTranslations from './locales/en';
import zhTranslations from './locales/zh';

type Locale = 'zh' | 'en';
type TranslationKey = keyof typeof zhTranslations | keyof typeof enTranslations;
type TranslationValues = Record<string, string | number>;

const translations: Record<Locale, Record<string, string>> = {
  zh: zhTranslations,
  en: enTranslations,
};

class I18n {
  private currentLocale: Locale = 'en';

  setLocale(locale: Locale) {
    this.currentLocale = locale;
  }

  /**
   * Translate a key, filling `{{name}}` placeholders from `values` (unknown
   * placeholders are kept). A key missing from the current locale falls back
   * to the other one, then to the key itself.
   */
  t(key: TranslationKey, values?: TranslationValues): string {
    const fallbackLocale = this.currentLocale === 'zh' ? 'en' : 'zh';
    const template =
      translations[this.currentLocale][key] ||
      translations[fallbackLocale][key] ||
      String(key);
    if (!values) {
      return template;
    }
    return template.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      const value = values[name];
      return value !== undefined ? String(value) : match;
    });
  }
}

const i18n = new I18n();

export default i18n;
