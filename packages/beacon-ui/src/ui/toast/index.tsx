import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { Subject, Subscription } from '../../utils/subject'
import Toast from 'src/components/toast'
import { ToastConfig } from '../common'

// Import the bundled CSS as a raw string
import cssText from './aggregated.css'
import { getColorMode } from '../../utils/colorMode'

let initDone: boolean = false
const config$ = new Subject<ToastConfig | undefined>()
const show$ = new Subject<boolean>()
let lastTimer: ReturnType<typeof setTimeout> | undefined
const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

// Track when openToast was last called and how many consecutive calls were made.
let lastCallTimestamp = 0
let requestCount = 0
const BASE_DELAY = 500
const COOLDOWN = 2000
const DELAY_INCREMENT = 100

const clearPendingTimers = () => {
  pendingTimers.forEach((timerId) => clearTimeout(timerId))
  pendingTimers.clear()
}

const clearAutoCloseTimer = () => {
  if (lastTimer !== undefined) {
    clearTimeout(lastTimer)
    lastTimer = undefined
  }
}

const applyToastConfig = (config: ToastConfig) => {
  clearAutoCloseTimer()
  config$.next(config)
  show$.next(true)
  if (config.timer) {
    lastTimer = setTimeout(() => {
      lastTimer = undefined
      closeToast()
    }, config.timer)
  }
}

const createToast = (config: ToastConfig) => {
  // Create the host element
  const el = document.createElement('beacon-toast')
  document.body.prepend(el)

  // Attach an open Shadow DOM to the host element
  const shadowRoot = el.attachShadow({ mode: 'open' })

  const styleEl = document.createElement('style')
  styleEl.textContent = cssText
  shadowRoot.appendChild(styleEl)

  // Create a container element for React to render into
  const container = document.createElement('div')
  shadowRoot.appendChild(container)

  initDone = true
  // Render the Toast synchronously into the container within the Shadow DOM
  createRoot(container).render(<ToastRoot {...config} />)
}

const openToast = (config: ToastConfig) => {
  const now = Date.now()

  // Reset the counter if more than COOLDOWN ms have passed since the last call.
  if (now - lastCallTimestamp > COOLDOWN) {
    requestCount = 1
  } else {
    requestCount++
  }
  lastCallTimestamp = now

  // Calculate delay: first request is immediate, second is BASE_DELAY,
  // subsequent requests add DELAY_INCREMENT ms for each additional call.
  const timeoutDelay = requestCount === 1 ? 0 : BASE_DELAY + (requestCount - 2) * DELAY_INCREMENT

  if (!initDone) {
    clearPendingTimers()
    applyToastConfig(config)
    createToast(config)
  } else if (timeoutDelay === 0) {
    clearPendingTimers()
    applyToastConfig(config)
  } else {
    const timerId = setTimeout(() => {
      pendingTimers.delete(timerId)
      applyToastConfig(config)
    }, timeoutDelay)
    pendingTimers.add(timerId)
  }
}

const closeToast = () => {
  clearPendingTimers()
  clearAutoCloseTimer()
  requestCount = 0
  lastCallTimestamp = 0
  config$.next(undefined)
  show$.next(false)
}

const ToastRoot = (props: ToastConfig) => {
  const [config, setConfig] = useState<ToastConfig | undefined>(() =>
    config$.hasEmitted() ? config$.getValue() : props
  )
  const [isOpen, setIsOpen] = useState<boolean>(() =>
    show$.hasEmitted() ? Boolean(show$.getValue()) : true
  )
  const [mount, setMount] = useState<boolean>(() => {
    const initialConfig = config$.hasEmitted() ? config$.getValue() : props
    const initialOpen = show$.hasEmitted() ? Boolean(show$.getValue()) : true
    return Boolean(initialConfig && initialOpen)
  })

  useEffect(() => {
    const subs: Subscription[] = []
    subs.push(
      config$.subscribe((nextConfig) => {
        setConfig(nextConfig)
      })
    )
    subs.push(
      show$.subscribe((value) => {
        setIsOpen(value)
      })
    )
    return () => subs.forEach((sub) => sub.unsubscribe())
  }, [])

  useEffect(() => {
    // Unmount immediately if the toast is closed.
    if (!config || !isOpen) {
      setMount(false)
      return
    }
    setMount(true)
  }, [isOpen, config])

  return (
    <>
      <div className={`theme__${getColorMode()}`}>
        {mount && config && (
          <Toast
            label={config.body}
            open={isOpen}
            onClickClose={closeToast}
            actions={config.actions}
            walletInfo={config.walletInfo}
            openWalletAction={config.openWalletAction}
          />
        )}
      </div>
    </>
  )
}

export { closeToast, openToast }
