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
  vi.resetAllMocks()
  state.channel.onmessage = null
  state.elector.isLeader = false
  state.elector.hasLeader.mockResolvedValue(true)
  state.elector.awaitLeadership.mockImplementation(async () => {
    state.elector.isLeader = true
  })
  state.elector.die.mockImplementation(async () => {
    state.elector.isLeader = false
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

for (const departure of ['close', 'unload'] as const) {
  it(`announces ${departure} after leadership was acquired before channel initialization`, async () => {
    const inbound = vi.fn()
    const elected = vi.fn()
    const channel = new MultiTabChannel('restored-role', inbound, elected)
    try {
      await channel.getLeadership()
      expect(channel.isLeader()).toBe(true)
      await channel.init()
      // The elector can already have cleared its flag when the unload listener runs.
      state.elector.isLeader = false
      if (departure === 'close') {
        await channel.close()
      } else {
        window.dispatchEvent(new Event('beforeunload'))
        await vi.waitFor(() =>
          expect(state.channel.postMessage.mock.calls).toEqual([[{ type: 'LEADER_DEAD' }]])
        )
      }
      expect(state.channel.postMessage.mock.calls).toEqual([[{ type: 'LEADER_DEAD' }]])
      expect(inbound).not.toHaveBeenCalled()
      expect(elected).not.toHaveBeenCalled()
    } finally {
      if (departure !== 'close') await channel.close()
    }
  })

  it(`announces ${departure} after explicit leadership acquisition by an initialized follower`, async () => {
    const channel = new MultiTabChannel('promoted-role', vi.fn(), vi.fn())
    try {
      await channel.init()
      expect(channel.isLeader()).toBe(false)
      await channel.getLeadership()
      expect(channel.isLeader()).toBe(true)
      state.elector.isLeader = false
      if (departure === 'close') {
        await channel.close()
      } else {
        window.dispatchEvent(new Event('beforeunload'))
        await vi.waitFor(() =>
          expect(state.channel.postMessage.mock.calls).toEqual([[{ type: 'LEADER_DEAD' }]])
        )
      }
      expect(state.channel.postMessage.mock.calls).toEqual([[{ type: 'LEADER_DEAD' }]])
    } finally {
      if (departure !== 'close') await channel.close()
    }
  })
}
