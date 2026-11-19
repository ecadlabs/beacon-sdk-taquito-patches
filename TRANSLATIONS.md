# Contributing Translations to Beacon SDK

Beacon SDK supports multi-language (`i18n`) and Right-to-Left (`RTL`) layouts across its UI modals, pairing flows, status toasts, and error descriptions.

English (`en`) serves as the canonical source of truth. Other built-in locales may start with AI-generated initial translations (`status: 'ai-draft'`) and are promoted to `'human-reviewed'` as native speakers and Tezos community contributors review and refine them.

## Built-in Locales

All built-in locale files live in [`packages/beacon-types/src/i18n/locales/`](packages/beacon-types/src/i18n/locales/):

| Code | Language | Native Name | Direction | Formality / Tone     | File                                           |
| ---- | -------- | ----------- | --------- | -------------------- | ---------------------------------------------- |
| `en` | English  | English     | `ltr`     | Neutral              | `packages/beacon-types/src/i18n/locales/en.ts` |
| `fr` | French   | Français    | `ltr`     | Formal (`vous`)      | `packages/beacon-types/src/i18n/locales/fr.ts` |
| `es` | Spanish  | Español     | `ltr`     | Informal (`tú`)      | `packages/beacon-types/src/i18n/locales/es.ts` |
| `de` | German   | Deutsch     | `ltr`     | Informal (`du`)      | `packages/beacon-types/src/i18n/locales/de.ts` |
| `ja` | Japanese | 日本語      | `ltr`     | Polite (`です/ます`) | `packages/beacon-types/src/i18n/locales/ja.ts` |
| `ar` | Arabic   | العربية     | `rtl`     | Modern Standard      | `packages/beacon-types/src/i18n/locales/ar.ts` |

## 1. Reviewing or Improving an Existing Translation

You do not need a full local build setup to improve wording in an existing locale file; you can edit the file directly in the GitHub web interface and open a pull request:

1. Open the locale file under `packages/beacon-types/src/i18n/locales/<locale>.ts` (compare side-by-side with `packages/beacon-types/src/i18n/locales/en.ts` for context).
2. Check domain-specific Tezos and wallet terminology (for example: _wallet_, _extension_, _hardware wallet_, _pairing_, _QR code_, _private key_, _network_, and _operation_).
3. Keep all template placeholders inside curly braces unchanged (`{{wallet}}`, `{{standard}}`, `{{suffix}}`, `{{payloadHash}}`, `{{signature}}`, `{{index}}`). Do not translate the identifier inside `{{...}}`.
4. Ensure link labels such as `ui.walletConnectErrors['relay-unreachable'].link.label` remain self-contained, descriptive link phrases (for example, _"View connection troubleshooting guide"_ rather than _"here"_) so screen readers can announce them meaningfully out of context.
5. Once you have reviewed the full file, update `meta.status` at the top of the locale object from `'ai-draft'` to `'human-reviewed'`.

## 2. Adding a New Language

Every locale implements the strict `BeaconLocaleMessages` TypeScript interface defined in [`packages/beacon-types/src/i18n/schema.ts`](packages/beacon-types/src/i18n/schema.ts). If any key is missing, TypeScript will report a compile-time error showing the exact missing key.

To add a new language (for example, Portuguese `pt`):

1. Copy `packages/beacon-types/src/i18n/locales/en.ts` to `packages/beacon-types/src/i18n/locales/pt.ts`.
2. Update the `meta` section (`locale`, `name`, `direction: 'ltr' | 'rtl'`, and `status: 'human-reviewed'` or `'ai-draft'`).
3. Translate all strings in `errors`, `dapp`, `ui`, and `aria`, preserving any `{{wallet}}`, `{{standard}}`, `{{suffix}}`, `{{payloadHash}}`, `{{signature}}`, and `{{index}}` tokens.
4. Register the new locale in `packages/beacon-types/src/i18n/locales/index.ts` (import `ptMessages` and add it to `builtInLocales`).
5. Run the i18n unit test suite to verify schema completeness and placeholder token parity:

```bash
npm run tsc --workspace=@ecadlabs/beacon-types
npx vitest run packages/beacon-types/__tests__/i18n.test.ts
```

## 3. Browser Language Detection and Overriding Translations in Your dApp

By default, when no explicit `locale` is configured, Beacon automatically detects the user's preferred language from `navigator.languages` / `navigator.language` (or a non-English `<html lang="...">` document attribute) and falls back to English (`en`) when no built-in locale matches. To pin your dApp's Beacon modals and toasts to English regardless of the user's browser language, pass `locale: 'en'` explicitly.

If you want to set a specific language, text direction, or custom strings in your dApp, pass `locale`, `direction`, and `translations` in `DAppClientOptions`, or update them at runtime on the `DAppClient` instance:

```ts
import { DAppClient } from '@ecadlabs/beacon-dapp'

const dAppClient = new DAppClient({
  name: 'My Tezos dApp',
  locale: 'fr',
  direction: 'auto', // 'ltr' | 'rtl' | 'auto'
  translations: {
    dapp: {
      choosePreferredWallet: 'Choisissez votre portefeuille Tezos'
    },
    ui: {
      connectWallet: 'Choisissez votre portefeuille Tezos'
    }
  }
})

// Switch language at runtime, or pass undefined to clear this client's override
// (reverting to any global baseline set via configureBeaconI18n / setBeaconLocale,
// or to automatic browser/document language detection):
dAppClient.setLocale('ar')
dAppClient.setLocale(undefined)
```

Any keys omitted in `translations` automatically fall back to the built-in locale catalog, and then to English (`en`). If you provide custom `translations` for a language not in `builtInLocales` (such as Italian `'it'` or Persian `'fa'`), pass `locale: 'it'` (or `locale: 'fa'`) alongside `translations` so Beacon sets `lang` and `dir` appropriately on its shadow hosts.
