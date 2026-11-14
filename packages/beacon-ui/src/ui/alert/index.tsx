import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { getColorMode } from 'src/utils/colorMode'
import { Subject, Subscription } from '../../utils/subject'
import { runUICallback } from '../../utils/callback'
import { AlertConfig, ConfigurableAlertProps } from '../common'
import { PairingAlert } from './components/pairing-alert'
import InfoAlert from './components/info-alert'

// Import the bundled CSS as a raw string
import cssText from './aggregated.css'

let initDone: boolean = false
const show$ = new Subject<boolean>()
const config$ = new Subject<AlertConfig>()

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
    config$.hasEmitted() ? (config$.getValue() as AlertConfig) : props
  )

  useEffect(() => {
    const subs: Subscription[] = []
    subs.push(show$.subscribe((value) => setIsOpen(value)))
    subs.push(config$.subscribe((value) => setConfig(value)))

    return () => subs.forEach((sub) => sub.unsubscribe())
  }, [])

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

  return (
    <div className={`theme__${getColorMode()}`}>
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
