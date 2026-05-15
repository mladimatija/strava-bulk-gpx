# Translations

This directory follows Chrome's [extension i18n](https://developer.chrome.com/docs/extensions/reference/api/i18n) layout. Each subdirectory is one locale, named with Chrome's locale code, and contains a `messages.json` with translated strings.

`_locales/en/messages.json` is the source of truth. When you add or change a string in the source code or `manifest.json`, update `en/messages.json` first.

## Currently shipped locales

The extension ships translations for every language [Strava itself supports](https://support.strava.com/hc/en-us/articles/216917337-Supported-Languages-on-Strava). Chrome picks the right one automatically based on the user's browser language; missing keys fall back to English (`default_locale`).

If `chrome.i18n.getMessage` is unavailable at runtime for any reason (a known edge case with MV3 content scripts loaded via dynamic import), the typed `t()` helper in `src/i18n.ts` falls back to a baked-in English copy of every string, so the toolbar still renders rather than throwing.

| Code    | Language                                   | Reviewed by a native speaker? |
| ------- | ------------------------------------------ | ----------------------------- |
| `en`    | English (default)                          | ✅ source of truth            |
| `cs`    | Čeština (Czech)                            | ❌ needs review               |
| `de`    | Deutsch (German)                           | ❌ needs review               |
| `es`    | Español (Spanish)                          | ❌ needs review               |
| `fr`    | Français (French)                          | ❌ needs review               |
| `it`    | Italiano (Italian)                         | ❌ needs review               |
| `ja`    | 日本語 (Japanese)                          | ❌ needs review               |
| `ko`    | 한국어 (Korean)                            | ❌ needs review               |
| `nb`    | Norsk Bokmål (Norwegian)                   | ❌ needs review               |
| `nl`    | Nederlands (Dutch)                         | ❌ needs review               |
| `pl`    | Polski (Polish)                            | ❌ needs review               |
| `pt_BR` | Português brasileiro (Portuguese - Brazil) | ❌ needs review               |
| `ru`    | Русский (Russian)                          | ❌ needs review               |
| `zh_CN` | 简体中文 (Chinese - Simplified)            | ❌ needs review               |
| `zh_TW` | 繁體中文 (Chinese - Traditional)           | ❌ needs review               |

**The non-English translations are machine-quality starting points, not professional translations.** They follow correct grammar and pick reasonable register, but a native speaker will likely find phrases that are slightly awkward or non-idiomatic for the domain (athletic tracking). If you speak one of these languages natively, a PR replacing the questionable phrasing is very welcome - flag the specific message key and explain why your wording reads better.

## Adding a new locale

1. Pick the right [Chrome locale code](https://developer.chrome.com/docs/extensions/reference/api/i18n#locales) (underscores, not hyphens - `pt_BR`, not `pt-BR`).
2. Copy `_locales/en/messages.json` to `_locales/<code>/messages.json`.
3. Translate each `message` value. Leave keys, `placeholders`, and `description` fields alone - those are not user-facing. The `$NAME$` tokens inside messages must stay verbatim; they get replaced at runtime with values like activity counts and ids.
4. Test in Chrome: change your browser language (chrome://settings/languages → move your locale to the top), reload the extension, visit Strava's My Activities page, confirm the toolbar shows your translation.
5. Add a row to the table above and open a PR.

If a string is missing from a locale's `messages.json`, Chrome falls back to the default locale (English), so it's safe to ship partial translations or drop a key while a translation is being rewritten.

## Conventions

- **Sentence case**, not Title Case, for buttons and labels - matches both Strava and Chrome extension conventions.
- **Keep `GPX` and `Ko-fi` as proper nouns.** They aren't translatable.
- **HTTP errors stay in English.** The `$REASON$` placeholder in `savedWithSkips` and `downloadFailed` carries values like `HTTP 404` or `Network error` that we surface verbatim - don't translate the surrounding text in a way that breaks if the reason is English.
- **Ellipses** in progress messages (`…`) should be the typographic single-character ellipsis, not three dots. Most translation tools handle this automatically.

## Reviewing translations

If you're a native speaker of a shipped locale and notice anything awkward, an issue or PR is welcome - please link to the specific message key.
