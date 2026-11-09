import { createLeaderElection, BroadcastChannel, LeaderElector } from 'broadcast-channel'

interface Message {
  type: string
  id: string
  data: any
}

const lifecycleObservers = new WeakMap<MultiTabChannel, () => void>()

/** @internal Observes leader departure before election for the channel's owning facade. */
export function observeMultiTabChannel(
  channel: MultiTabChannel,
  onLeaderDead: () => void
): () => void {
  const registration = () => onLeaderDead()
  lifecycleObservers.set(channel, registration)

  return () => {
    if (lifecycleObservers.get(channel) === registration) {
      lifecycleObservers.delete(channel)
    }
  }
}

export class MultiTabChannel {
  private readonly channel: BroadcastChannel
  private readonly elector: LeaderElector
  private readonly eventListeners = [
    () => this.onBeforeUnloadHandler(),
    (message: any) => this.onMessageHandler(message)
  ]
  private readonly onBCMessageHandler: Function
  private readonly onElectedLeaderHandler: Function
  // Auxiliary variable needed for handling beforeUnload.
  // Closing a tab causes the elector to be killed immediately
  private wasLeader: boolean = false
  private initialized: boolean = false
  private initialization: Promise<void> | undefined
  private closed: boolean = false

  constructor(name: string, onBCMessageHandler: Function, onElectedLeaderHandler: Function) {
    this.onBCMessageHandler = onBCMessageHandler
    this.onElectedLeaderHandler = onElectedLeaderHandler
    this.channel = new BroadcastChannel(name)
    this.elector = createLeaderElection(this.channel)
  }

  async init() {
    if (this.closed) {
      return
    }
    if (this.initialization) {
      return this.initialization
    }

    // A follower must receive departure signals even if it never wins an election.
    if (!this.initialized) {
      this.channel.onmessage = this.eventListeners[1]
      window?.addEventListener('beforeunload', this.eventListeners[0])
      this.initialized = true
    }
    this.wasLeader = this.wasLeader || this.isLeader()
    const initialize = async (): Promise<void> => {
      const hasLeader = await this.elector.hasLeader()
      if (this.closed) {
        return
      }
      if (!hasLeader) {
        await this.getLeadership()
      }
      if (!this.closed) {
        this.wasLeader = this.wasLeader || this.isLeader()
      }
    }
    const completion = initialize()
    this.initialization = completion
    completion.catch(() => {
      if (this.initialization === completion) {
        this.initialization = undefined
      }
    })

    return completion
  }

  public async close() {
    const wasLeader = this.wasLeader
    this.retireListeners()
    await this.elector.die()
    if (wasLeader) {
      this.postMessage({ type: 'LEADER_DEAD' })
    }
    await this.channel.close()
    this.initialized = false
    this.wasLeader = false
  }

  private async onBeforeUnloadHandler() {
    this.retireListeners()
    if (this.wasLeader) {
      await this.elector.die()
      this.postMessage({ type: 'LEADER_DEAD' })
    }
  }

  private retireListeners(): void {
    this.closed = true
    lifecycleObservers.delete(this)
    window?.removeEventListener('beforeunload', this.eventListeners[0])
    this.channel.removeEventListener('message', this.eventListeners[1])
    this.channel.onmessage = null
  }

  private async onMessageHandler(message: Message) {
    if (this.closed) {
      return
    }
    if (message.type === 'LEADER_DEAD') {
      lifecycleObservers.get(this)?.()
      if (this.closed) {
        return
      }
      await this.getLeadership()

      if (!this.closed && this.isLeader()) {
        this.onElectedLeaderHandler()
      }

      return
    }

    this.onBCMessageHandler(message)
  }

  isLeader(): boolean {
    return this.elector.isLeader
  }

  async getLeadership() {
    if (this.closed) {
      return
    }
    await this.elector.awaitLeadership()
    if (!this.closed) {
      this.wasLeader = this.wasLeader || this.isLeader()
    }
  }

  async hasLeader(): Promise<boolean> {
    return this.elector.hasLeader()
  }

  postMessage(message: any): void {
    this.channel.postMessage(message)
  }
}
