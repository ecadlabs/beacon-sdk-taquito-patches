import { ExposedPromise, generateGUID } from '@ecadlabs/beacon-utils'
import {
  ConnectionContext,
  TransportType,
  TransportStatus,
  BeaconBaseMessage,
  AccountInfo,
  PeerInfo,
  BeaconMessageType,
  DisconnectMessage,
  AppMetadata,
  BeaconRequestMessage,
  BeaconMessageWrapper,
  NodeDistributions
} from '@ecadlabs/beacon-types'
import { BeaconClient } from '../beacon-client/BeaconClient'
import { AccountManager } from '../../managers/AccountManager'
import { getSenderId } from '../../utils/get-sender-id'
import { Transport } from '../../transports/Transport'
import { Serializer } from '../../Serializer'
import { ClientOptions } from './ClientOptions'

interface TransportCleanupTarget {
  readonly type: TransportType
  removeListener(
    listener: (message: string, connectionInfo: ConnectionContext) => void
  ): Promise<void>
}

interface TransportListenerTarget extends TransportCleanupTarget {
  addListener(listener: Parameters<Transport['addListener']>[0]): Promise<void>
}

interface TransportSubscription {
  readonly transport: TransportCleanupTarget
  readonly listener: (message: unknown, connectionInfo: ConnectionContext) => Promise<void>
  readonly registration: ExposedPromise<void>
  active: boolean
  registered: boolean
  disposal?: Promise<void>
}

/**
 * @internalapi
 *
 * This abstract class handles the a big part of the logic that is shared between the dapp and wallet client.
 * For example, it selects and manages the transport and accounts.
 */
export abstract class Client extends BeaconClient {
  protected readonly accountManager: AccountManager

  /**
   * @param transportType the transport that delivered the message. Messages relayed between
   * tabs are handled without one.
   */
  protected handleResponse: (
    _event: BeaconRequestMessage | BeaconMessageWrapper<BeaconBaseMessage>,
    connectionInfo: ConnectionContext,
    transportType?: TransportType
  ) => void | Promise<void>

  /**
   * How many requests can be sent after another
   */
  protected readonly rateLimit: number = 2
  /**
   * The time window in seconds in which the "rateLimit" is checked
   */
  protected readonly rateLimitWindowInSeconds: number = 5

  /**
   * Stores the times when requests have been made to determine if the rate limit has been reached
   */
  protected requestCounter: number[] = []

  protected readonly matrixNodes: NodeDistributions

  private readonly transportListeners = new Set<TransportSubscription>()

  private readonly transportListenerRegistrations: Map<TransportType, Promise<void>> = new Map()

  protected _transport: ExposedPromise<Transport<any>> = new ExposedPromise()
  protected get transport(): Promise<Transport<any>> {
    return this._transport.promise
  }

  /**
   * Returns the connection status of the Client
   */
  public get connectionStatus(): TransportStatus {
    return this._transport.promiseResult?.connectionStatus ?? TransportStatus.NOT_CONNECTED
  }

  /**
   * Returns whether or not the transaport is ready
   */
  public get ready(): Promise<void> {
    return this.transport.then(() => undefined)
  }

  constructor(config: ClientOptions) {
    super(config)

    this.accountManager = new AccountManager(config.storage)
    this.matrixNodes = config.matrixNodes ?? {}

    this.handleResponse = (
      message: BeaconBaseMessage | BeaconMessageWrapper<BeaconBaseMessage>,
      connectionInfo: ConnectionContext
    ): void => {
      throw new Error(
        `not overwritten${JSON.stringify(message)} - ${JSON.stringify(connectionInfo)}`
      )
    }
  }
  protected async cleanup(transports?: TransportCleanupTarget[]) {
    const subscriptions = [...this.transportListeners].filter(
      (subscription) => !transports || transports.includes(subscription.transport)
    )
    // Retire delivery before awaiting registration or physical callback removal.
    subscriptions.forEach((subscription) => {
      subscription.active = false
    })
    const results = await Promise.allSettled(
      subscriptions.map((subscription) => this.disposeTransportSubscription(subscription))
    )
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason
      }
    }
  }

  private disposeTransportSubscription(subscription: TransportSubscription): Promise<void> {
    subscription.active = false
    if (subscription.disposal) {
      return subscription.disposal
    }
    const dispose = async (): Promise<void> => {
      await subscription.registration.promise.catch(() => undefined)
      if (subscription.registered) {
        await subscription.transport.removeListener(subscription.listener)
      }
      this.transportListeners.delete(subscription)
    }
    const disposal = dispose()
    subscription.disposal = disposal
    disposal.catch(() => {
      if (subscription.disposal === disposal) {
        subscription.disposal = undefined
      }
    })

    return disposal
  }

  /**
   * Return all locally known accounts
   */
  public async getAccounts(): Promise<AccountInfo[]> {
    return this.accountManager.getAccounts()
  }

  /**
   * Return the account by ID
   * @param accountIdentifier The ID of an account
   */
  public async getAccount(accountIdentifier: string): Promise<AccountInfo | undefined> {
    return this.accountManager.getAccount(accountIdentifier)
  }

  /**
   * Remove the account by ID
   * @param accountIdentifier The ID of an account
   */
  public async removeAccount(accountIdentifier: string): Promise<void> {
    return this.accountManager.removeAccount(accountIdentifier)
  }

  /**
   * Remove all locally stored accounts
   */
  public async removeAllAccounts(): Promise<void> {
    return this.accountManager.removeAllAccounts()
  }

  /**
   * Add a new request (current timestamp) to the pending requests, remove old ones and check if we are above the limit
   */
  public async addRequestAndCheckIfRateLimited(): Promise<boolean> {
    const now: number = new Date().getTime()
    this.requestCounter = this.requestCounter.filter(
      (date) => date + this.rateLimitWindowInSeconds * 1000 > now
    )

    this.requestCounter.push(now)

    return this.requestCounter.length > this.rateLimit
  }

  /**
   * This method initializes the client. It will check if the connection should be established to a
   * browser extension or if the P2P transport should be used.
   *
   * @param transport A transport that can be provided by the user
   */
  public async init(transport: Transport<any>): Promise<TransportType> {
    if (this._transport.isResolved()) {
      return (await this.transport).type
    }

    await this.setTransport(transport) // Let users define their own transport

    return transport.type
  }

  /**
   * Returns the metadata of this DApp
   */
  public async getOwnAppMetadata(): Promise<AppMetadata> {
    return {
      senderId: await getSenderId(await this.beaconId),
      name: this.name,
      icon: this.iconUrl
    }
  }

  /**
   * Return all known peers
   */
  public async getPeers(): Promise<PeerInfo[]> {
    return (await this.transport).getPeers()
  }

  /**
   * Add a new peer to the known peers
   * @param peer The new peer to add
   */
  public async addPeer(peer: PeerInfo): Promise<void> {
    return (await this.transport).addPeer(peer)
  }

  public async destroy(): Promise<void> {
    if (this._transport.isResolved()) {
      const transport = await this.transport
      await this.cleanup()
      await transport.disconnect()
      if (transport.type === TransportType.WALLETCONNECT) {
        await (transport as any).doClientCleanup() // any because I cannot import the type definition
      }
    }
    await super.destroy()
  }

  /**
   * A "setter" for when the transport needs to be changed.
   */
  protected async setTransport(transport?: Transport<any>): Promise<void> {
    if (transport) {
      if (this._transport.isSettled()) {
        // If the promise has already been resolved we need to create a new one.
        this._transport = ExposedPromise.resolve(transport)
      } else {
        this._transport.resolve(transport)
      }
    } else {
      if (this._transport.isSettled()) {
        // If the promise has already been resolved we need to create a new one.
        this._transport = new ExposedPromise()
      }
    }
  }

  protected async registerTransportListener(
    transport: TransportListenerTarget,
    listener: Parameters<Transport['addListener']>[0]
  ): Promise<void> {
    await transport.addListener(listener)
  }

  protected async addListener(transport: TransportListenerTarget): Promise<void> {
    const subscription: TransportSubscription = {
      transport,
      registration: new ExposedPromise<void>(),
      active: true,
      registered: false,
      listener: async (message, connectionInfo) => {
        if (!subscription.active || typeof message !== 'string') {
          return
        }
        const deserializedMessage = (await new Serializer().deserialize(
          message
        )) as BeaconRequestMessage
        if (subscription.active) {
          await this.handleResponse(deserializedMessage, connectionInfo, transport.type)
        }
      }
    }
    subscription.registration.promise.catch(() => undefined)
    this.transportListeners.add(subscription)
    const previous = this.transportListenerRegistrations.get(transport.type) ?? Promise.resolve()
    const registration = previous
      .catch(() => undefined)
      .then(async () => {
        if (!subscription.active) {
          return
        }
        for (const current of this.transportListeners) {
          if (
            current !== subscription &&
            current.transport.type === transport.type &&
            current.registered
          ) {
            await this.disposeTransportSubscription(current)
          }
        }
        if (!subscription.active) {
          return
        }
        await this.registerTransportListener(transport, subscription.listener)
        subscription.registered = true
      })
    this.transportListenerRegistrations.set(transport.type, registration)

    try {
      await registration
      subscription.registration.resolve()
    } catch (error) {
      subscription.active = false
      this.transportListeners.delete(subscription)
      subscription.registration.reject(error)
      throw error
    } finally {
      if (this.transportListenerRegistrations.get(transport.type) === registration) {
        this.transportListenerRegistrations.delete(transport.type)
      }
    }
  }

  protected async sendDisconnectToPeer(peer: PeerInfo, transport?: Transport<any>): Promise<void> {
    const request: DisconnectMessage = {
      id: await generateGUID(),
      version: peer.version,
      senderId: await getSenderId(await this.beaconId),
      type: BeaconMessageType.Disconnect
    }

    const payload = await new Serializer().serialize(request)
    const selectedTransport = transport ?? (await this.transport)

    await selectedTransport.send(payload, peer)
  }
}
