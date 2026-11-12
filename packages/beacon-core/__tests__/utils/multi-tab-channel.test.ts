import { Logger } from '../../src/utils/Logger'
import { MultiTabChannel } from '../../src/utils/multi-tab-channel'

const state = vi.hoisted(() => ({
  channel: {
    onmessage: null as null | ((message: { type: string }) => Promise<void>),
    postMessage: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn()
  },
  elector: { isLeader: false, hasLeader: vi.fn(), awaitLeadership: vi.fn(), die: vi.fn() }
}))
vi.mock('broadcast-channel', () => ({
  BroadcastChannel: class {
    constructor() {
      return state.channel
    }
  },
  createLeaderElection: () => state.elector
}))

beforeEach(() => {
  vi.clearAllMocks()
  state.channel.postMessage.mockResolvedValue(undefined)
  state.elector.isLeader = false
  state.elector.hasLeader.mockResolvedValue(true)
  state.elector.awaitLeadership.mockImplementation(async () => {
    state.elector.isLeader = true
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('forwards inbound and outbound messages without electing a second leader', async () => {
  const inbound = vi.fn()
  const elected = vi.fn()
  const channel = new MultiTabChannel('test', inbound, elected)
  await channel.init()
  await channel.init()
  expect(state.elector.hasLeader).toHaveBeenCalledTimes(1)
  expect(channel.isLeader()).toBe(false)
  expect(await channel.hasLeader()).toBe(true)
  const message = { type: 'RESPONSE', id: 'one', data: 'payload' }
  channel.postMessage(message)
  expect(state.channel.postMessage).toHaveBeenCalledWith(message)
  await state.channel.onmessage?.(message)
  expect(inbound).toHaveBeenCalledWith(message)
  expect(elected).not.toHaveBeenCalled()
  await channel.close()
  expect(state.channel.onmessage).toBeNull()
  expect(state.channel.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function))
  expect(state.channel.close).toHaveBeenCalledTimes(1)
})
it('elects a successor on LEADER_DEAD and announces its own departure', async () => {
  const inbound = vi.fn()
  const elected = vi.fn()
  const channel = new MultiTabChannel('test', inbound, elected)
  await channel.init()
  await state.channel.onmessage?.({ type: 'LEADER_DEAD' })
  expect(channel.isLeader()).toBe(true)
  expect(elected).toHaveBeenCalledTimes(1)
  expect(inbound).not.toHaveBeenCalled()
  await channel.close()
  expect(state.elector.die).toHaveBeenCalledTimes(1)
  expect(state.channel.postMessage).toHaveBeenCalledWith({ type: 'LEADER_DEAD' })
})
it('claims leadership when the adapter reports no existing leader', async () => {
  state.elector.hasLeader.mockResolvedValue(false)
  const channel = new MultiTabChannel('fallback', vi.fn(), vi.fn())
  await channel.init()
  expect(channel.isLeader()).toBe(true)
  await channel.getLeadership()
  expect(state.elector.awaitLeadership).toHaveBeenCalledTimes(2)
  channel.postMessage({ type: 'REQUEST' })
  expect(state.channel.postMessage).toHaveBeenCalledWith({ type: 'REQUEST' })
  await channel.close()
})

it('delivers between real adapter channels without native BroadcastChannel', async () => {
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.doUnmock('broadcast-channel')
  vi.resetModules()
  const { MultiTabChannel: RealMultiTabChannel } = await import('../../src/utils/multi-tab-channel')
  const received = vi.fn()
  const name = `fallback-${Date.now()}`
  const sender = new RealMultiTabChannel(name, vi.fn(), vi.fn())
  const receiver = new RealMultiTabChannel(name, received, vi.fn())
  try {
    await sender.init()
    await receiver.init()
    const message = { type: 'REQUEST', id: 'fallback', data: 'payload' }
    sender.postMessage(message)
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(message))
  } finally {
    await receiver.close()
    await sender.close()
    vi.doMock('broadcast-channel', () => ({
      BroadcastChannel: class {
        constructor() {
          return state.channel
        }
      },
      createLeaderElection: () => state.elector
    }))
    vi.resetModules()
  }
})

it.each([false, true])(
  'detaches beforeunload and channel listeners on unload (leader=%s)',
  async (leader) => {
    state.elector.hasLeader.mockResolvedValue(!leader)
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const channel = new MultiTabChannel('unload', vi.fn(), vi.fn())
    try {
      await channel.init()
      const registration = add.mock.calls.find(([event]) => event === 'beforeunload')
      expect(registration).toBeDefined()
      window.dispatchEvent(new Event('beforeunload'))
      await vi.waitFor(() => expect(remove).toHaveBeenCalledWith('beforeunload', registration?.[1]))
      expect(state.channel.removeEventListener).toHaveBeenCalledWith(
        'message',
        expect.any(Function)
      )
      expect(state.elector.die).toHaveBeenCalledTimes(leader ? 1 : 0)
      expect(state.channel.postMessage).toHaveBeenCalledTimes(leader ? 1 : 0)
      if (leader) expect(state.channel.postMessage).toHaveBeenCalledWith({ type: 'LEADER_DEAD' })
    } finally {
      await channel.close()
    }
  }
)
it('removes the exact beforeunload listener when explicitly closed', async () => {
  const add = vi.spyOn(window, 'addEventListener')
  const remove = vi.spyOn(window, 'removeEventListener')
  const channel = new MultiTabChannel('close', vi.fn(), vi.fn())
  await channel.init()
  const registration = add.mock.calls.find(([event]) => event === 'beforeunload')
  expect(registration).toBeDefined()
  await channel.close()
  expect(remove).toHaveBeenCalledWith('beforeunload', registration?.[1])
})

it('observes asynchronous message callback failures', async () => {
  const failure = new Error('application callback failed')
  const warn = vi.spyOn(Logger.prototype, 'warn')
  const channel = new MultiTabChannel(
    'callback-failure',
    async () => {
      throw failure
    },
    vi.fn()
  )
  await channel.init()
  await state.channel.onmessage?.({ type: 'RESPONSE' })
  expect(warn).toHaveBeenCalledWith('message callback', failure)
  await channel.close()
})

it('waits for the departure broadcast before closing the sender', async () => {
  state.elector.hasLeader.mockResolvedValue(false)
  let finish: () => void = () => {}
  state.channel.postMessage.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  const channel = new MultiTabChannel('ordered-close', vi.fn(), vi.fn())
  await channel.init()
  const closing = channel.close()
  await Promise.resolve()
  expect(state.channel.close).not.toHaveBeenCalled()
  finish()
  await closing
  expect(state.channel.close).toHaveBeenCalledOnce()
})

it('reports detached outbound failures', async () => {
  const failure = new Error('broadcast failed')
  const warn = vi.spyOn(Logger.prototype, 'warn')
  state.channel.postMessage.mockRejectedValueOnce(failure)
  const channel = new MultiTabChannel('send-failure', vi.fn(), vi.fn())
  channel.postMessage({ type: 'REQUEST' })
  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('postMessage', failure))
  await channel.close()
})
