import { createRoot } from 'react-dom/client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getBeaconDirection, resolveBeaconLang, subscribeBeaconI18n } from '@ecadlabs/beacon-types'
import { getColorMode, subscribeColorMode } from '../../utils/colorMode'
import { Subject, Subscription } from '../../utils/subject'
import { runUICallback } from '../../utils/callback'
import { ensureDialogFocus, getActiveElementDeep } from '../../utils/focus'
import { AlertConfig, ConfigurableAlertProps } from '../common'
import { PairingAlert } from './components/pairing-alert'
import { InfoAlert } from './components/info-alert'

// Import the bundled CSS as a raw string
import cssText from './aggregated.css'

let initDone: boolean = false
let alertHostEl: HTMLElement | undefined
let previouslyFocusedElement: HTMLElement | null = null
const show$ = new Subject<boolean>()
const config$ = new Subject<AlertConfig>()

const capturePreviousFocus = (): void => {
  if (typeof document === 'undefined') {
    return
  }
  const hostActive = document.activeElement
  if (
    alertHostEl &&
    (hostActive === alertHostEl ||
      (hostActive instanceof Node && alertHostEl.shadowRoot?.contains(hostActive)))
  ) {
    return
  }
  const active = getActiveElementDeep()
  if (active && active !== document.body && active !== document.documentElement) {
    previouslyFocusedElement = active
  }
}

const restorePreviousFocus = (): void => {
  const target = previouslyFocusedElement
  previouslyFocusedElement = null
  if (target && typeof target.focus === 'function' && target.isConnected) {
    try {
      target.focus()
    } catch {
      // Ignore focus errors on detached/disabled elements
    }
  }
}

const syncAlertHostAttributes = (el?: HTMLElement): void => {
  const target =
    el ?? alertHostEl ?? document.querySelector<HTMLElement>('beacon-alert') ?? undefined
  if (!target) {
    return
  }
  target.setAttribute('dir', getBeaconDirection())
  target.setAttribute('lang', resolveBeaconLang())
}

const closeAlert = () => {
  show$.next(false)
}

const AlertRoot = (props: AlertConfig) => {
  const [isOpen, setIsOpen] = useState<boolean>(() =>
    show$.hasEmitted() ? Boolean(show$.getValue()) : true
  )
  const [mount, setMount] = useState<boolean>(() =>
    show$.hasEmitted() ? Boolean(show$.getValue()) : true
  )
  const [config, setConfig] = useState<AlertConfig>(() =>
    config$.hasEmitted() ? (config$.getValue() ?? props) : props
  )
  const [, setI18nRevision] = useState<number>(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const wasOpenRef = useRef<boolean>(false)

  useEffect(() => {
    const subs: Subscription[] = []
    subs.push(show$.subscribe((value) => setIsOpen(value)))
    subs.push(config$.subscribe((value) => setConfig(value)))
    const notifyUiStateChange = () => {
      syncAlertHostAttributes()
      setI18nRevision((rev) => rev + 1)
    }
    const unsubscribeI18n = subscribeBeaconI18n(notifyUiStateChange)
    const unsubscribeColorMode = subscribeColorMode(notifyUiStateChange)
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('languagechange', notifyUiStateChange)
    }
    let docObserver: MutationObserver | undefined
    if (
      typeof MutationObserver !== 'undefined' &&
      typeof document !== 'undefined' &&
      document.documentElement
    ) {
      docObserver = new MutationObserver(notifyUiStateChange)
      docObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['lang', 'dir']
      })
    }

    return () => {
      subs.forEach((sub) => sub.unsubscribe())
      unsubscribeI18n()
      unsubscribeColorMode()
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('languagechange', notifyUiStateChange)
      }
      docObserver?.disconnect()
    }
  }, [])

  useEffect(() => {
    syncAlertHostAttributes()
  }, [isOpen, config])

  useEffect(() => {
    // Wait before unmounting so the fade-out animation can complete,
    // and cancel the timer if the alert is reopened before 300ms.
    if (isOpen) {
      setMount(true)

      return
    }
    const timer = setTimeout(() => setMount(false), 300)

    return () => clearTimeout(timer)
  }, [isOpen])

  useLayoutEffect(() => {
    const rootNode = rootRef.current
    if (!isOpen || !mount) {
      if (!isOpen && wasOpenRef.current) {
        wasOpenRef.current = false
        restorePreviousFocus()
      }

      return
    }
    wasOpenRef.current = true
    const dialog = rootNode?.querySelector<HTMLElement>('[role="dialog"]')
    if (!dialog) {
      return
    }
    ensureDialogFocus(dialog)

    if (typeof MutationObserver === 'undefined') {
      return
    }
    const observer = new MutationObserver(() => {
      ensureDialogFocus(dialog)
    })
    observer.observe(dialog, { childList: true, subtree: true })

    return () => observer.disconnect()
  }, [isOpen, mount, config])

  const onCloseHandler = () => {
    closeAlert()
    runUICallback(() => config.closeButtonCallback?.(), 'Alert', 'closeButtonCallback')
  }

  const filteredProps: ConfigurableAlertProps = {
    ...config,
    onClose: onCloseHandler,
    open: isOpen,
    closeOnBackdropClick: true
  }

  const dir = getBeaconDirection()
  const lang = resolveBeaconLang()

  return (
    <div ref={rootRef} className={`theme__${getColorMode()}`} dir={dir} lang={lang}>
      {mount &&
        (config.pairingPayload ? (
          <PairingAlert {...filteredProps} pairingPayload={config.pairingPayload} />
        ) : (
          <InfoAlert {...filteredProps} />
        ))}
    </div>
  )
}

const createAlert = (config: AlertConfig) => {
  // Create the host element
  const el = document.createElement('beacon-alert')
  alertHostEl = el
  syncAlertHostAttributes(el)
  document.body.prepend(el)

  // Attach an open Shadow DOM to the host element
  const shadowRoot = el.attachShadow({ mode: 'open' })

  // Inject the bundled CSS into the shadow root
  const styleEl = document.createElement('style')
  styleEl.textContent = cssText
  shadowRoot.appendChild(styleEl)

  // Create a container for React to render into
  const container = document.createElement('div')
  shadowRoot.appendChild(container)

  initDone = true
  // Render the Alert synchronously into the Shadow DOM
  createRoot(container).render(<AlertRoot {...config} />)
}

const openAlert = (config: AlertConfig) => {
  capturePreviousFocus()
  syncAlertHostAttributes()
  config$.next(config)
  show$.next(true)
  if (!initDone) {
    createAlert(config)
  }
}

/**
 * @deprecated use `closeAlert` instead
 */
const closeAlerts = () => {
  closeAlert()
}

export { openAlert, closeAlert, closeAlerts }
