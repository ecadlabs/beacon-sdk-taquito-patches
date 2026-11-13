type Callback = (message: unknown) => void

interface WindowRef {
  postMessage(message: unknown, target?: string): void
  addEventListener(name: string, eventCallback: Callback): void
  removeEventListener(name: string, eventCallback: Callback): void
  location: { origin: string }
  beaconCreatedClientInstance?: boolean
  beaconSdkDebugEnabled?: unknown
}

const cbs: Callback[] = []

/**
 * A mock for postmessage if run in node.js environment
 */
let windowRef: WindowRef = {
  postMessage: (message: unknown): void => {
    cbs.slice().forEach((callbackElement: Callback) => {
      if (cbs.includes(callbackElement)) {
        callbackElement({ data: message })
      }
    })
  },
  addEventListener: (_name: string, eventCallback: Callback): void => {
    cbs.push(eventCallback)
  },
  removeEventListener: (_name: string, eventCallback: Callback): void => {
    const index = cbs.indexOf(eventCallback)
    if (index !== -1) {
      cbs.splice(index, 1)
    }
  },
  location: {
    origin: '*'
  }
}

try {
  if (typeof window !== 'undefined') {
    windowRef = window
  }
} catch {
  // Keep the Node fallback if the browser window cannot be accessed.
}

const clearMockWindowState: () => void = (): void => {
  cbs.length = 0
}

export { windowRef, clearMockWindowState }
