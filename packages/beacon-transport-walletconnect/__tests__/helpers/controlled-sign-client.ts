import { SessionTypes } from '@walletconnect/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
type Reply =
  | { signature: string }
  | { operationHash: string }
  | Array<{ algo: string; address: string; pubkey: string }>
type WireRequest = { topic: string; request: { method: string; params: unknown } }
export const mockRequests: Array<{
  input: WireRequest
  reply: ReturnType<typeof deferred<Reply>>
}> = []
export const mockApprovals: Array<ReturnType<typeof deferred<SessionTypes.Struct>>> = []
export const mockPings: Array<ReturnType<typeof deferred<void>>> = []
export const mockHandlers = new Map<string, (event: unknown) => void>()
const metadata = { name: 'wallet', description: '', url: 'https://wallet.example', icons: [] }
export const account = 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb'
export function session(topic: string): SessionTypes.Struct {
  return {
    topic,
    pairingTopic: 'pairing',
    relay: { protocol: 'irn' },
    expiry: Math.floor(Date.now() / 1000) + 604800,
    acknowledged: true,
    controller: 'wallet',
    namespaces: {
      tezos: {
        accounts: [`tezos:mainnet:${account}`],
        methods: ['tezos_getAccounts', 'tezos_sign', 'tezos_send'],
        events: ['requestAcknowledged']
      }
    },
    sessionProperties: { pubkey: 'edpk-test-public-key', algo: 'ed25519', address: account },
    requiredNamespaces: {},
    optionalNamespaces: {},
    self: { publicKey: 'dapp-key', metadata },
    peer: { publicKey: 'wallet-key', metadata }
  }
}
let mockSession: SessionTypes.Struct
let mockHoldPing = false
export const mockRemote = {
  session: {
    get keys() {
      return [mockSession.topic]
    },
    get: () => mockSession,
    getAll: () => [mockSession]
  },
  pairing: { getAll: () => [] },
  on: (name: string, callback: (event: unknown) => void) => {
    mockHandlers.set(name, callback)
  },
  removeAllListeners: jest.fn(),
  disconnect: jest.fn(async () => {}),
  connect: jest.fn(async () => {
    const approval = deferred<SessionTypes.Struct>()
    mockApprovals.push(approval)
    return { uri: 'wc:pairing@2?symKey=test', approval: () => approval.promise }
  }),
  ping: jest.fn(() => {
    if (!mockHoldPing) return Promise.resolve()
    const ping = deferred<void>()
    mockPings.push(ping)
    return ping.promise
  }),
  request: jest.fn((input: WireRequest) => {
    const reply = deferred<Reply>()
    mockRequests.push({ input, reply })
    return reply.promise
  }),
  core: {
    events: { removeAllListeners: jest.fn() },
    heartbeat: { stop: jest.fn() },
    relayer: {
      transportClose: jest.fn(async () => {}),
      events: { removeAllListeners: jest.fn() },
      provider: {
        events: { removeAllListeners: jest.fn() },
        connection: { events: { removeAllListeners: jest.fn() } }
      },
      subscriber: { events: { removeAllListeners: jest.fn() } }
    },
    pairing: {
      events: { on: jest.fn(), removeAllListeners: jest.fn() },
      getPairings: () => [],
      ping: jest.fn(async () => {}),
      disconnect: jest.fn(async () => {})
    }
  }
}

export function resetWire() {
  mockApprovals.length = 0
  mockRequests.length = 0
  mockPings.length = 0
  mockHandlers.clear()
  mockSession = session('current')
  mockHoldPing = false
}
export function restoreSession(topic: string) {
  mockSession = session(topic)
  mockHoldPing = false
}
export function holdPings() {
  mockHoldPing = true
}
export const flush = () => jest.advanceTimersByTimeAsync(0)

// Storage notifications are local to each test; no browser tabs or relay exist.
export function installLocalChannel() {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel')
  beforeAll(() =>
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      value: class {
        onmessage: unknown
        onmessageerror: unknown
        postMessage(_message: unknown): void {}
        close(): void {}
      }
    })
  )
  afterAll(() => {
    if (original) Object.defineProperty(globalThis, 'BroadcastChannel', original)
    else Reflect.deleteProperty(globalThis, 'BroadcastChannel')
  })
}
