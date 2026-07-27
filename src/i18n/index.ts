// Self-contained localization for the viewer. Deliberately NOT wired to the host's ABP-driven
// localization pipeline: the viewer is AGPL-isolated in an iframe, so it carries its own tiny
// bundled dictionaries and learns the locale from the `?lang=` URL param the host appends to the
// iframe src (alongside `?host=`). The param is available synchronously at load, which matters
// because most viewer text is static markup in index.html that paints before any postMessage.

import cs from './cs.json';
import en from './en.json';

type Dictionary = Record<string, string>;
type Locale = 'cs' | 'en';

const DICTIONARIES: Record<Locale, Dictionary> = {
	cs: cs as Dictionary,
	en: en as Dictionary
};
const DEFAULT_LOCALE: Locale = 'cs';

function resolveLocale(): Locale {
	const lang = new URLSearchParams(location.search).get('lang');
	return lang === 'en' ? 'en' : DEFAULT_LOCALE;
}

const locale: Locale = resolveLocale();
const dictionary: Dictionary = DICTIONARIES[locale];

/**
 * Look up a translation and substitute positional `{0}`, `{1}`, … placeholders.
 * Falls back to the raw key when a translation is missing (mirrors the SPA's `L()` semantics).
 */
export function t(key: string, ...params: string[]): string {
	const template = dictionary[key] ?? key;
	if (params.length === 0) return template;
	return template.replace(/\{(\d+)\}/g, (match, index: string) => params[Number(index)] ?? match);
}

/**
 * Declarative one-shot pass over the static index.html markup: fills `textContent`, `title` and
 * `aria-label` from `data-i18n` / `data-i18n-title` / `data-i18n-aria-label` attributes, and syncs
 * the document language. Call once at startup.
 */
export function applyStaticI18n(): void {
	document.documentElement.lang = locale;

	document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
		const key = el.dataset.i18n;
		if (key) el.textContent = t(key);
	});
	document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
		const key = el.dataset.i18nTitle;
		if (key) el.title = t(key);
	});
	document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((el) => {
		const key = el.dataset.i18nAriaLabel;
		if (key) el.setAttribute('aria-label', t(key));
	});
}
