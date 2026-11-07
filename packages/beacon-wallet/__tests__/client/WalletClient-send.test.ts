import { LocalStorage } from '@ecadlabs/beacon-core'
import { ExposedPromise, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { BeaconErrorType, BeaconMessageType, NetworkType, Origin } from '@ecadlabs/beacon-types'
import { WalletClient } from '../../src/client/WalletClient'
import { WalletPostMessageTransport } from '../../src/transports/WalletPostMessageTransport'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

const request = {
  id: 'request',
  senderId: 'dapp',
  version: '2',
  type: BeaconMessageType.PermissionRequest as const,
  appMetadata: { senderId: 'dapp', name: 'Dapp' },
  network: { type: NetworkType.MAINNET },
  scopes: []
}
const context = { origin: Origin.EXTENSION, id: 'peer' }

async function setup() {
  const storage = new LocalStorage()
  const transport = new WalletPostMessageTransport(
    'Wallet',
    await getKeypairFromSeed('send'),
    storage
  )
  const wallet = new WalletClient({ name: 'Wallet', storage })
  const transportOwner = wallet as unknown as { readonly transport: (typeof wallet)['transport'] }
  vi.spyOn(transportOwner, 'transport', 'get').mockResolvedValue(transport)
  vi.spyOn(wallet, '_connect').mockResolvedValue(undefined)
  const send = vi.spyOn(transport, 'send').mockResolvedValue(undefined)
  const received = vi.fn()
  await wallet.connect(received)
  return { wallet, transport, send, received }
}

it.each([
  ['2', 'pending'],
  ['2', 'rejected'],
  ['3', 'pending'],
  ['3', 'rejected']
])('delivers V%s incoming requests despite a %s ACK send', async (version, state) => {
  const { wallet, transport, send, received } = await setup()
  const gate = new ExposedPromise<void>()
  send.mockReturnValue(gate.promise)
  if (state === 'rejected') gate.reject(new Error('ACK failed'))
  // Observe rejection before the async ACK pipeline attaches to this transport promise.
  gate.promise.catch(() => undefined)
  const incoming =
    version === '2'
      ? request
      : {
          ...request,
          version,
          message: {
            ...request,
            blockchainIdentifier: 'tezos',
            blockchainData: { appMetadata: request.appMetadata }
          }
        }
  const delivery = Promise.resolve(wallet['handleResponse']!(incoming, context))
  delivery.catch(() => undefined)
  try {
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1))
    await delivery
    await wallet['handleResponse']!(incoming, context)
    expect(received).toHaveBeenCalledTimes(1)
  } finally {
    if (state === 'pending') gate.resolve()
    await delivery.catch(() => undefined)
    await transport.disconnect()
  }
})

it.each(['respond', 'ack'] as const)(
  'waits for %s transport sends and propagates rejection',
  async (operation) => {
    const { wallet, transport, send } = await setup()
    const gate = new ExposedPromise<void>()
    if (operation === 'respond') {
      await wallet['handleResponse']!(request, context)
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    }
    send.mockClear().mockReturnValue(gate.promise)
    const sending =
      operation === 'respond'
        ? wallet.respond({
            id: request.id,
            type: BeaconMessageType.Error,
            errorType: BeaconErrorType.ABORTED_ERROR
          })
        : wallet['sendAcknowledgeResponse'](request, context)
    const failure = new Error('send failed')
    let settled = false
    const result = sending.then(
      () => {
        settled = true
      },
      (error: unknown) => {
        settled = true
        return error
      }
    )
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      gate.reject(failure)
      expect(await result).toBe(failure)
    } finally {
      gate.resolve()
      await transport.disconnect()
    }
  }
)
