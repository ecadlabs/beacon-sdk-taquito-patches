import { Logger, windowRef } from '@ecadlabs/beacon-core'
import { Extension, ExtensionMessageTarget } from '@ecadlabs/beacon-types'

const logger = new Logger('BeaconUIExtensions')

// Inlined from PostMessageTransport.getAvailableExtensions to keep beacon-ui from importing
// the full postmessage transport and its key-agreement dependencies during Rollup.
let listeningForExtensions = false
let extensionsPromise: Promise<Extension[]> | undefined
let extensions: Extension[] | undefined

interface WindowMessageEvent {
  data?: unknown
  source?: unknown
  origin?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isWindowMessageEvent = (event: unknown): event is WindowMessageEvent => isRecord(event)

const isExtension = (sender: unknown): sender is Extension => {
  if (!isRecord(sender)) {
    return false
  }

  return typeof sender.id === 'string' && typeof sender.name === 'string'
}

const addExtension = (extension: Extension): void => {
  if (!extensions) {
    extensions = []
  }

  if (!extensions.some((ext) => ext.id === extension.id)) {
    extensions.push(extension)
    windowRef.postMessage('extensionsUpdated', windowRef.location.origin)
  }
}

const listenForExtensions = (): void => {
  if (listeningForExtensions) {
    return
  }

  const handler = (event: unknown): void => {
    if (
      !isWindowMessageEvent(event) ||
      event.source !== windowRef ||
      event.origin !== windowRef.location.origin
    ) {
      return
    }

    const data = event.data
    if (!isRecord(data) || data.payload !== 'pong' || !isExtension(data.sender)) {
      return
    }

    logger.log('getAvailableExtensions', `extension "${data.sender.name}" is available`, data.sender)
    addExtension(data.sender)
  }

  windowRef.addEventListener('message', handler)

  windowRef.postMessage(
    {
      target: ExtensionMessageTarget.EXTENSION,
      payload: 'ping'
    },
    windowRef.location.origin
  )

  listeningForExtensions = true
}

export const getAvailableExtensions = async (): Promise<Extension[]> => {
  if (extensionsPromise) {
    return extensionsPromise
  }

  if (extensions) {
    return extensions
  }

  extensions = []
  extensionsPromise = new Promise<Extension[]>((resolve) => {
    listenForExtensions()

    setTimeout(() => {
      resolve(extensions ?? [])
    }, 1000)
  }).finally(() => {
    extensionsPromise = undefined
  })

  return extensionsPromise
}
