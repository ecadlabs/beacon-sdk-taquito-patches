import { BeaconLocaleMessages } from '../schema'
import { enMessages } from './en'
import { frMessages } from './fr'
import { esMessages } from './es'
import { deMessages } from './de'
import { jaMessages } from './ja'
import { arMessages } from './ar'

export { enMessages, frMessages, esMessages, deMessages, jaMessages, arMessages }

export const builtInLocales: Readonly<Record<string, BeaconLocaleMessages>> = {
  en: enMessages,
  fr: frMessages,
  es: esMessages,
  de: deMessages,
  ja: jaMessages,
  ar: arMessages
}
