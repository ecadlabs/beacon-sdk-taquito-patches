import { createLeaderElection, BroadcastChannel, LeaderElector } from 'broadcast-channel'
import { Logger } from './Logger'

const logger = new Logger('MultiTabChannel')

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
  private readonly channel: BroadcastChannel<unknown>
  private readonly elector: LeaderElector
  private readonly beforeUnloadListener = () =>
    this.onBeforeUnloadHandler().catch((error: unknown) => logger.warn('beforeunload', error))
  private readonly messageListener = (message: unknown) =>
    this.onMessageHandler(message).catch((error: unknown) => logger.warn('message callback', error))
  private readonly onBCMessageHandler: (message: unknown) => unknown
  private readonly onElectedLeaderHandler: () => unknown
  // Auxiliary variable needed for handling beforeUnload.
  // Closing a tab causes the elector to be killed immediately
  private wasLeader: boolean = false
  private initialized: boolean = false
  private initialization: Promise<void> | undefined
  private closed: boolean = false

  constructor(
    name: string,
    onBCMessageHandler: (message: unknown) => unknown,
    onElectedLeaderHandler: () => unknown
  ) {
    this.onBCMessageHandler = onBCMessageHandler
    this.onElectedLeaderHandler = onElectedLeaderHandler
    this.channel = new BroadcastChannel<unknown>(name)
    this.elector = createLeaderElection(this.channel)
  }

  public async init() {
    if (this.closed) {
      return
    }
    if (this.initialization) {
      return this.initialization
    }

    // A follower must receive departure signals even if it never wins an election.
    if (!this.initialized) {
      this.channel.onmessage = this.messageListener
      window?.addEventListener('beforeunload', this.beforeUnloadListener)
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
    try {
      await this.elector.die()
      if (wasLeader) {
        await this.channel.postMessage({ type: 'LEADER_DEAD' })
      }
    } finally {
      await this.channel.close()
      this.initialized = false
      this.wasLeader = false
    }
  }

  private async onBeforeUnloadHandler() {
    this.retireListeners()
    if (this.wasLeader) {
      await this.elector.die()
      await this.channel.postMessage({ type: 'LEADER_DEAD' })
    }
  }

  private retireListeners(): void {
    this.closed = true
    lifecycleObservers.delete(this)
    window?.removeEventListener('beforeunload', this.beforeUnloadListener)
    this.channel.removeEventListener('message', this.messageListener)
    this.channel.onmessage = null
  }

  private async onMessageHandler(message: unknown) {
    if (this.closed) {
      return
    }
    if (
      message !== null &&
      (typeof message === 'object' || typeof message === 'function') &&
      'type' in message &&
      message.type === 'LEADER_DEAD'
    ) {
      lifecycleObservers.get(this)?.()
      if (this.closed) {
        return
      }
      await this.getLeadership()

      if (!this.closed && this.isLeader()) {
        this.notifyCallback('leader callback', () => this.onElectedLeaderHandler())
      }

      return
    }

    this.notifyCallback('message callback', () => this.onBCMessageHandler(message))
  }

  private notifyCallback(context: string, callback: () => unknown): void {
    try {
      Promise.resolve(callback()).catch((error: unknown) => logger.warn(context, error))
    } catch (error: unknown) {
      logger.warn(context, error)
    }
  }

  public isLeader(): boolean {
    return this.elector.isLeader
  }

  public async getLeadership() {
    if (this.closed) {
      return
    }
    await this.elector.awaitLeadership()
    if (!this.closed) {
      this.wasLeader = this.wasLeader || this.isLeader()
    }
  }

  public async hasLeader(): Promise<boolean> {
    return this.elector.hasLeader()
  }

  public postMessage(message: unknown): void {
    this.channel.postMessage(message).catch((error: unknown) => logger.warn('postMessage', error))
  }
}
