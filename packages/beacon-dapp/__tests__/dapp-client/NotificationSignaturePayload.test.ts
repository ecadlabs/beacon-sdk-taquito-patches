import { signMessage, toHex } from '@ecadlabs/beacon-utils'
import { LocalStorage } from '@ecadlabs/beacon-core'
import { DAppClient } from '../../src/dapp-client/DAppClient'

type SendNotificationFn = (notification: {
  url: string
  recipient: string
  title: string
  body: string
  payload: string
  protocolIdentifier: string
  accessToken: string
}) => Promise<string>

describe('DAppClient notification signature payload', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('encodes UTF-8 byte length (not hex character length) in the signed notification payload', async () => {
    let capturedBody: {
      recipient: string
      title: string
      body: string
      timestamp: string
      payload: string
      sender: { publicKey: string; signature: string }
    } | null = null

    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      } as unknown as Response
    }) as unknown as typeof fetch

    const client = new DAppClient({
      name: 'Notification Test dApp',
      storage: new LocalStorage(`dapp-notif-${Math.random()}`),
      disableDefaultEvents: true
    })

    try {
      const sendNotification = (
        client as unknown as { sendNotificationWithAccessToken: SendNotificationFn }
      ).sendNotificationWithAccessToken.bind(client)

      await sendNotification({
        url: 'https://notifications.example.org',
        recipient: 'tz1recipient',
        title: 'Café alert',
        body: 'Transfer ready',
        payload: 'payload-1',
        protocolIdentifier: 'tezos',
        accessToken: 'token-123'
      })

      expect(capturedBody).not.toBeNull()
      const body = capturedBody!
      const constructedString = [
        'Tezos Signed Message: ',
        body.recipient,
        body.title,
        body.body,
        body.timestamp,
        body.payload
      ].join(' ')
      const hex = toHex(constructedString)
      const byteLength = hex.length / 2
      const expectedPayload = `0501${byteLength.toString(16).padStart(8, '0')}${hex}`

      const keyPair = await (client as unknown as { keyPair: Promise<{ secretKey: Uint8Array }> })
        .keyPair
      const expectedSignature = await signMessage(expectedPayload, {
        secretKey: Buffer.from(keyPair.secretKey)
      })

      expect(body.sender.signature).toBe(expectedSignature)
    } finally {
      await client.destroy()
    }
  })
})
