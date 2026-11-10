import { setImmediate } from 'node:timers/promises'
import { clientSessionKeys } from '@stablelib/x25519-session'
import { LocalStorage, getSenderId } from '@ecadlabs/beacon-core'
import {
  ExposedPromise,
  getKeypairFromSeed,
  toHex,
  getHexHash,
  encryptCryptoboxPayload,
  convertPublicKeyToX25519,
  convertSecretKeyToX25519
} from '@ecadlabs/beacon-utils'
import { ExtendedP2PPairingResponse, StorageKey, TransportStatus } from '@ecadlabs/beacon-types'
import { P2PTransport } from '../src/P2PTransport'
import { P2PCommunicationClient } from '../src/communication-client/P2PCommunicationClient'
import { MatrixClient } from '../src/matrix-client/MatrixClient'
import { MatrixClientEventType } from '../src/matrix-client/models/MatrixClientEvent'
import { MatrixUserService } from '../src/matrix-client/services/MatrixUserService'
import { MatrixEventService } from '../src/matrix-client/services/MatrixEventService'
import { MatrixLoginResponse } from '../src/matrix-client/models/api/MatrixLogin'
import { MatrixSyncResponse } from '../src/matrix-client/models/api/MatrixSync'

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
  localStorage.clear()
})

it('removes persisted peers from an unused Matrix transport without starting a connection', async () => {
  const storage = new LocalStorage('unused-matrix-cleanup')
  const peer: ExtendedP2PPairingResponse = {
    id: 'wallet',
    name: 'Wallet',
    version: '2',
    type: 'p2p-pairing-response',
    publicKey: toHex((await getKeypairFromSeed('unused-matrix-peer')).publicKey),
    senderId: 'wallet',
    relayServer: 'relay.example'
  }
  await storage.set(StorageKey.TRANSPORT_P2P_PEERS_DAPP, [peer])
  const transport = new P2PTransport(
    'Restored extension dApp',
    await getKeypairFromSeed('unused-matrix-dapp'),
    storage,
    {},
    StorageKey.TRANSPORT_P2P_PEERS_DAPP
  )
  const relayLookup = vi.spyOn(P2PCommunicationClient.prototype, 'getRelayServer')
  expect(await transport.getPeers()).toEqual([peer])

  await transport.removeAllPeers()

  expect(await transport.getPeers()).toEqual([])
  expect(await storage.get(StorageKey.TRANSPORT_P2P_PEERS_DAPP)).toEqual([])
  expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
  expect(relayLookup).not.toHaveBeenCalled()
})

it('retires pending encrypted listeners during login and allows a fresh subscription', async () => {
  vi.useFakeTimers()
  const storage = new LocalStorage('pending-matrix-cleanup')
  const keys = await getKeypairFromSeed('pending-matrix-dapp')
  const peerKeys = await getKeypairFromSeed('pending-matrix-wallet')
  const peerPublicKey = toHex(peerKeys.publicKey)
  const client = new P2PCommunicationClient('Dapp', keys, 1, storage)
  const loginEntered = new ExposedPromise<void>()
  const login = new ExposedPromise<MatrixLoginResponse>()
  const polling = new ExposedPromise<MatrixSyncResponse>()
  const unsubscribe = vi.spyOn(MatrixClient.prototype, 'unsubscribe')
  vi.spyOn(client, 'getRelayServer').mockResolvedValue({
    server: 'relay.example',
    timestamp: 12345
  })
  vi.spyOn(MatrixUserService.prototype, 'login').mockImplementation(() => {
    loginEntered.resolve()
    return login.promise
  })
  vi.spyOn(MatrixEventService.prototype, 'sync')
    .mockResolvedValueOnce({ next_batch: 'initial', rooms: {} })
    .mockImplementation(() => polling.promise)
  const starting = client.start()
  await loginEntered.promise
  const staleCallback = vi.fn()
  const pendingSubscription = client.listenForEncryptedMessage(peerPublicKey, staleCallback)
  try {
    await client.unsubscribeFromEncryptedMessages()
    expect(unsubscribe).toHaveBeenCalledExactlyOnceWith(
      MatrixClientEventType.MESSAGE,
      expect.any(Function)
    )
    login.resolve({ user_id: '@dapp:relay.example', device_id: 'device', access_token: 'token' })
    await starting
    await pendingSubscription
    const currentCallback = vi.fn()
    await client.listenForEncryptedMessage(peerPublicKey, currentCallback)
    await vi.advanceTimersByTimeAsync(0)
    const shared = clientSessionKeys(
      {
        publicKey: convertPublicKeyToX25519(peerKeys.publicKey),
        secretKey: convertSecretKeyToX25519(peerKeys.secretKey)
      },
      convertPublicKeyToX25519(keys.publicKey)
    )
    const message = JSON.stringify({
      id: 'current-message',
      senderId: await getSenderId(peerPublicKey)
    })
    const payload = await encryptCryptoboxPayload(message, shared.send)
    const sender = `@${await getHexHash(peerKeys.publicKey)}:relay.example`
    polling.resolve({
      next_batch: 'message',
      rooms: {
        join: {
          '!room:relay.example': {
            state: { events: [] },
            timeline: {
              events: [
                {
                  type: 'm.room.message',
                  sender,
                  event_id: '$message',
                  origin_server_ts: Date.now(),
                  content: { msgtype: 'm.text', body: payload }
                }
              ]
            }
          }
        }
      }
    })
    await setImmediate()
    expect(staleCallback).not.toHaveBeenCalled()
    expect(currentCallback).toHaveBeenCalledExactlyOnceWith(message)
  } finally {
    login.resolve({ user_id: '@dapp:relay.example', device_id: 'device', access_token: 'token' })
    await starting
    await client.stop()
  }
})
