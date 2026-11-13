import {
  ExposedPromise,
  ExposedPromiseStatus,
  generateGUID,
  getHexHash,
  decryptCryptoboxPayload,
  encryptCryptoboxPayload,
  getKeypairFromSeed,
  KeyPair,
  openCryptobox,
  recipientString,
  secretbox_MACBYTES,
  secretbox_NONCEBYTES,
  sign,
  toHex
} from '@ecadlabs/beacon-utils'
import {
  Storage,
  P2PPairingRequest,
  StorageKey,
  StorageKeyReturnType,
  ExtendedP2PPairingResponse,
  P2PPairingResponse,
  NodeDistributions,
  Regions
} from '@ecadlabs/beacon-types'
import {
  PendingPairingRequests,
  Serializer,
  PeerManager,
  BEACON_VERSION,
  getSenderId,
  Logger,
  CommunicationClient,
  ClientEvents
} from '@ecadlabs/beacon-core'
import { hash } from '@stablelib/blake2b'
import { encode } from '@stablelib/utf8'
import { MatrixClient } from '../matrix-client/MatrixClient'
import {
  MatrixClientEvent,
  MatrixClientEventType,
  MatrixClientEventMessageContent
} from '../matrix-client/models/MatrixClientEvent'
import { MatrixMessageType } from '../matrix-client/models/MatrixMessage'
import { MatrixRoom } from '../matrix-client/models/MatrixRoom'

const logger = new Logger('P2PCommunicationClient')

const RESPONSE_WAIT_TIME_MS: number = 60_000 // total wait time for all the probes

const REGIONS_AND_SERVERS: NodeDistributions = {
  [Regions.EUROPE_WEST]: [
    'beacon-node-1.octez.io',
    'beacon-node-2.octez.io',
    'beacon-node-3.octez.io',
    'beacon-node-4.octez.io',
    'beacon-node-5.octez.io',
    'beacon-node-6.octez.io',
    'beacon-node-7.octez.io',
    'beacon-node-8.octez.io'
  ]
}

interface BeaconInfoResponse {
  region: string
  known_servers: string[]
  timestamp: number
}

interface MatrixSessionIdentity {
  readonly id: symbol
  readonly ready: ExposedPromise<MatrixClient>
}

interface MatrixJoinSession extends MatrixSessionIdentity {
  readonly matrixClient: MatrixClient
}

type PeerRoomIds = StorageKeyReturnType[StorageKey.MATRIX_PEER_ROOM_IDS]

const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'

const isMatrixError = (error: unknown): error is { errcode: string } =>
  typeof error === 'object' &&
  error !== null &&
  'errcode' in error &&
  typeof error.errcode === 'string'

/**
 * @internalapi
 */
export class P2PCommunicationClient extends CommunicationClient {
  public cancelPairingRequests(): Promise<void> {
    return this.pendingPairings.cancel()
  }

  private startingClient: MatrixClient | undefined
  private startupGeneration = 0

  private client: ExposedPromise<MatrixClient> = this.createReadiness()
  private startup: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private cancelStartup: (() => void) | undefined
  private sessionActive = true
  private readonly retryTimers = new Map<ReturnType<typeof setTimeout>, () => void>()
  private relayAbort = new AbortController()
  private readonly matrixStops = new Map<MatrixClient, Promise<void>>()
  private readonly subscriptions = new Set<{
    client: MatrixClient
    event: MatrixClientEventType
    listener: unknown
    dispose: () => void
  }>()

  private matrixClient: MatrixClient | undefined

  private session = Symbol('Matrix session')

  private sessionStateWrite: Promise<void> = Promise.resolve()

  private initialReplay = {
    pending: 0,
    buffered: new WeakSet(),
    claimed: new WeakSet()
  }

  private initialEvent: MatrixClientEvent<MatrixClientEventType.MESSAGE> | undefined
  private initialListener:
    ((event: MatrixClientEvent<MatrixClientEventType.MESSAGE>) => void) | undefined

  private selectedRegion?: Regions
  private readonly ENABLED_RELAY_SERVERS: NodeDistributions
  private readonly customMatrixNodes?: NodeDistributions
  public relayServer:
    ExposedPromise<{ server: string; timestamp: number; localTimestamp: number }> | undefined
  private activeRelayServer: string | undefined

  public get currentRelayServer(): string | undefined {
    return this.activeRelayServer ?? this.relayServer?.promiseResult?.server
  }

  private recordRelayServer(server: string): void {
    const previous = this.activeRelayServer
    this.activeRelayServer = server
    if (previous !== undefined && previous !== server) {
      const onTransportStatus = this.eventHandlers.get(ClientEvents.TRANSPORT_STATUS)
      if (onTransportStatus) {
        Promise.resolve(
          onTransportStatus({
            reason: 'relay_changed',
            relayServer: server
          })
        ).catch((error: unknown) => logger.warn('recordRelayServer', error))
      }
    }
  }

  private readonly activeListeners: Map<
    string,
    (event: MatrixClientEvent<MatrixClientEventType.MESSAGE>) => void
  > = new Map()

  private ignoredRooms: string[] = []
  private readonly knownRelayServers: Set<string> = new Set()
  private seenCiphertexts: Set<string> = new Set()
  private inFlightCiphertexts: Set<string> = new Set()
  private loginCounter: number = 0

  constructor(
    private readonly name: string,
    keyPair: KeyPair,
    public readonly replicationCount: number,
    private readonly storage: Storage,
    matrixNodes?: NodeDistributions,
    private readonly iconUrl?: string,
    private readonly appUrl?: string,
    private readonly pendingPairings = new PendingPairingRequests()
  ) {
    super(keyPair)

    logger.log('constructor', 'P2PCommunicationClient created')

    this.ENABLED_RELAY_SERVERS = REGIONS_AND_SERVERS
    this.customMatrixNodes = matrixNodes

    if (matrixNodes) {
      this.ENABLED_RELAY_SERVERS = {
        ...REGIONS_AND_SERVERS,
        ...matrixNodes
      }
    }
  }

  public async getPairingRequestInfo(): Promise<P2PPairingRequest> {
    const generation = this.pendingPairings.generation
    const info: P2PPairingRequest = new P2PPairingRequest(
      await generateGUID(),
      this.name,
      await this.getPublicKey(),
      BEACON_VERSION,
      (await this.getRelayServer()).server
    )

    if (this.iconUrl) {
      info.icon = this.iconUrl
    }
    if (this.appUrl) {
      info.appUrl = this.appUrl
    }

    this.pendingPairings.add(info.id, generation)

    return info
  }

  public async getPairingResponseInfo(request: P2PPairingRequest): Promise<P2PPairingResponse> {
    const info: P2PPairingResponse = new P2PPairingResponse(
      request.id,
      this.name,
      await this.getPublicKey(),
      request.version,
      (await this.getRelayServer()).server
    )

    if (this.iconUrl) {
      info.icon = this.iconUrl
    }
    if (this.appUrl) {
      info.appUrl = this.appUrl
    }

    return info
  }

  /**
   * To get the fastest region, we can't simply do one request, because sometimes,
   * DNS and SSL handshakes make "faster" connections slower. So we need to do 2 requests
   * and check which request was the fastest after 1s.
   */
  public async findBestRegionAndGetServer(
    session = this.session
  ): Promise<{ server: string; timestamp: number } | undefined> {
    this.assertRelaySession(session)
    if (this.selectedRegion && this.relayServer?.promiseResult) {
      return this.relayServer.promiseResult
    }

    // 1) Flatten out [region, server] pairs and shuffle for randomness
    interface Probe {
      server: string
      region: Regions
    }
    const probes: Probe[] = Object.entries(this.ENABLED_RELAY_SERVERS)
      .flatMap(([region, servers]) =>
        servers.map((server) => ({ server, region: region as Regions }))
      )
      .sort(() => Math.random() - 0.5)

    // 2) Fire off all probes in parallel, each catching its own errors
    interface Result {
      server: string
      region: Regions
      time: number
      timestamp: number
    }
    const results: Result[] = []

    const probePromises = probes.map(({ server, region }) =>
      (async () => {
        const start = Date.now()
        try {
          const info = await this.getBeaconInfo(server)
          this.assertRelaySession(session)
          results.push({
            server,
            region,
            time: Date.now() - start,
            timestamp: info.timestamp
          })
        } catch (err) {
          logger.warn(`probe for ${server} failed:`, err)
          // swallow the error so Promise.all never rejects
        }
      })()
    )

    // 3) Wait until either:
    //    • all probes settle (fast regions), or
    //    • we hit our global timeout
    const signal = this.relayAbort.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel = (): void => undefined
    const deadline = new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, RESPONSE_WAIT_TIME_MS)
      cancel = () => reject(new DOMException('Matrix discovery cancelled', 'AbortError'))
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) {
        cancel()
      }
    })
    try {
      await Promise.race([Promise.all(probePromises), deadline])
      this.assertRelaySession(session)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
    }

    // 4) If nobody replied, bail out
    if (results.length === 0) {
      throw new Error('No server responded.')
    }

    // 5) Pick the lowest-latency reply
    const best = results.reduce((a, b) => (b.time < a.time ? b : a))

    if (session === this.session) {
      this.selectedRegion = best.region
    }

    return { server: best.server, timestamp: best.timestamp }
  }

  public async getRelayServer(): Promise<{ server: string; timestamp: number }> {
    const owner = this.captureSession()
    const session = owner.id
    this.assertRelaySession(session)
    if (this.relayServer) {
      const currentPromise = this.relayServer
      const relayServer = await currentPromise.promise
      this.assertRelaySession(session)
      if (Date.now() - relayServer.localTimestamp < 60 * 1000) {
        this.recordRelayServer(relayServer.server)

        return { server: relayServer.server, timestamp: relayServer.timestamp }
      }
      try {
        const info = await this.getBeaconInfo(relayServer.server)
        this.assertRelaySession(session)
        if (this.relayServer === currentPromise) {
          this.relayServer = ExposedPromise.resolve({
            server: relayServer.server,
            timestamp: info.timestamp,
            localTimestamp: Date.now()
          })
        }
        this.recordRelayServer(relayServer.server)

        return { server: relayServer.server, timestamp: info.timestamp }
      } catch (error) {
        this.assertRelaySession(session)
        const replacement = this.relayServer
        if (replacement && replacement !== currentPromise) {
          const latest = await replacement.promise
          this.assertRelaySession(session)
          this.recordRelayServer(latest.server)

          return { server: latest.server, timestamp: latest.timestamp }
        }
        logger.log('getRelayServer', `cached server ${relayServer.server} is unreachable`, error)
        await this.writeSessionState(owner, () =>
          this.storage
            .delete(StorageKey.MATRIX_SELECTED_NODE)
            .catch((failure) => logger.log(failure))
        )
        this.assertRelaySession(session)
        if (this.relayServer === currentPromise) {
          this.relayServer = undefined
          this.selectedRegion = undefined
        }
      }
    }

    if (this.relayServer) {
      const relayServer = await this.relayServer.promise
      this.assertRelaySession(session)
      this.recordRelayServer(relayServer.server)

      return { server: relayServer.server, timestamp: relayServer.timestamp }
    }

    const discovery = new ExposedPromise<{
      server: string
      timestamp: number
      localTimestamp: number
    }>()
    // The initiating caller observes its own rejection; there may be no other waiters.
    discovery.promise.catch(() => undefined)
    this.relayServer = discovery
    try {
      const node = await this.storage.get(StorageKey.MATRIX_SELECTED_NODE)
      this.assertRelaySession(session)
      if (node && node.length > 0) {
        const customServers = this.customMatrixNodes
          ? Object.values(this.customMatrixNodes).flatMap((servers) => servers ?? [])
          : []
        const hasCustomServers = customServers.length > 0
        const isNodeAllowed = !hasCustomServers || customServers.includes(node)

        if (!isNodeAllowed) {
          await this.writeSessionState(owner, () =>
            this.storage
              .delete(StorageKey.MATRIX_SELECTED_NODE)
              .catch((failure) => logger.log(failure))
          )
          this.assertRelaySession(session)
        } else {
          try {
            const info = await this.getBeaconInfo(node)
            this.assertRelaySession(session)
            if (!this.selectedRegion) {
              const isRegionKey = (key: string): key is Regions =>
                Object.values<string>(Regions).includes(key)
              const matchingRegion = Object.entries(this.ENABLED_RELAY_SERVERS).find(
                ([key, servers]) => isRegionKey(key) && servers?.includes(node)
              )?.[0]
              const fallbackRegion = Object.keys(this.ENABLED_RELAY_SERVERS).find(isRegionKey)
              const candidate = matchingRegion ?? fallbackRegion
              if (candidate && isRegionKey(candidate)) {
                this.selectedRegion = candidate
              }
            }
            discovery.resolve({ server: node, timestamp: info.timestamp, localTimestamp: Date.now() })
            this.recordRelayServer(node)

            return { server: node, timestamp: info.timestamp }
          } catch (error) {
            this.assertRelaySession(session)
            logger.log('getRelayServer', `stored node ${node} is unreachable`, error)
            await this.writeSessionState(owner, () =>
              this.storage
                .delete(StorageKey.MATRIX_SELECTED_NODE)
                .catch((failure) => logger.log(failure))
            )
            this.assertRelaySession(session)
          }
        }
      }
      const server = await this.findBestRegionAndGetServer(session)
      this.assertRelaySession(session)
      if (!server) {
        throw new Error('No servers found')
      }
      if (this.relayServer === discovery) {
        await this.writeSessionState(owner, () =>
          this.storage
            .set(StorageKey.MATRIX_SELECTED_NODE, server.server)
            .catch((error) => logger.log(error))
        )
        this.assertRelaySession(session)
      }
      discovery.resolve({ ...server, localTimestamp: Date.now() })
      this.recordRelayServer(server.server)

      return server
    } catch (error) {
      discovery.reject(error)
      if (session === this.session && this.relayServer === discovery) {
        this.relayServer = undefined
      }
      throw error
    }
  }

  private assertRelaySession(session: symbol): void {
    if (session !== this.session || this.relayAbort.signal.aborted) {
      throw new DOMException('Matrix discovery cancelled', 'AbortError')
    }
  }

  public async getBeaconInfo(server: string): Promise<BeaconInfoResponse> {
    const session = this.session
    this.assertRelaySession(session)
    const sessionSignal = this.relayAbort.signal
    const request = new AbortController()
    let cancel = (): void => undefined
    const timer = setTimeout(() => {
      request.abort(new DOMException('Relay request timed out', 'TimeoutError'))
      sessionSignal.removeEventListener('abort', cancel)
    }, 10_000)
    const dispose = (): void => {
      clearTimeout(timer)
      sessionSignal.removeEventListener('abort', cancel)
    }
    cancel = (): void => {
      request.abort(new DOMException('Matrix discovery cancelled', 'AbortError'))
      dispose()
    }
    sessionSignal.addEventListener('abort', cancel, { once: true })
    try {
      const response = await fetch(`https://${server}/_synapse/client/beacon/info`, {
        signal: request.signal
      })
      this.assertRelaySession(session)
      if (!response.ok) {
        throw new Error(`getBeaconInfo ${server} failed: ${response.status} ${response.statusText}`)
      }
      const data = (await response.json()) as BeaconInfoResponse
      this.assertRelaySession(session)
      this.knownRelayServers.add(server)
      for (const knownServer of data.known_servers ?? []) {
        if (typeof knownServer === 'string' && knownServer.length > 0) {
          this.knownRelayServers.add(knownServer)
        }
      }

      return {
        region: data.region,
        known_servers: data.known_servers,
        timestamp: Math.floor(data.timestamp)
      }
    } finally {
      dispose()
    }
  }

  private async isTrustedRelayServer(relay: string): Promise<boolean> {
    if (
      Object.values(this.ENABLED_RELAY_SERVERS).some((servers) => servers.includes(relay)) ||
      this.knownRelayServers.has(relay)
    ) {
      return true
    }
    if (this.relayServer?.isResolved()) {
      const current = await this.relayServer.promise.catch(() => undefined)
      if (current?.server === relay) {
        return true
      }
    }

    return false
  }

  private async isAuthorizedPeerInviter(
    inviter: string,
    peers: { publicKey: string; relayServer: string }[]
  ): Promise<boolean> {
    const [inviterHash, ...inviterRelayParts] = inviter.split(':')
    const inviterRelay = inviterRelayParts.join(':')
    if (!inviterHash.startsWith('@') || !inviterRelay) {
      return false
    }
    for (const peer of peers) {
      const peerHash = `@${await getHexHash(Buffer.from(peer.publicKey, 'hex'))}`
      if (
        peerHash === inviterHash &&
        (peer.relayServer === inviterRelay || (await this.isTrustedRelayServer(inviterRelay)))
      ) {
        return true
      }
    }

    return false
  }

  private subscribe<T extends MatrixClientEventType>(
    client: MatrixClient,
    event: T,
    listener: (event: MatrixClientEvent<T>) => void
  ): void {
    const subscription = {
      client,
      event,
      listener,
      dispose: (): void => {
        this.subscriptions.delete(subscription)
        client.unsubscribe(event, listener)
      }
    }
    this.subscriptions.add(subscription)
    client.subscribe(event, listener)
  }

  private unsubscribe<T extends MatrixClientEventType>(
    client: MatrixClient,
    event: T,
    listener: (event: MatrixClientEvent<T>) => void
  ): void {
    const subscription = [...this.subscriptions].find(
      (entry) => entry.client === client && entry.event === event && entry.listener === listener
    )
    if (subscription) {
      subscription.dispose()
    } else {
      client.unsubscribe(event, listener)
    }
  }

  private disposeSubscriptions(client?: MatrixClient): void {
    for (const subscription of this.subscriptions) {
      if (!client || subscription.client === client) {
        try {
          subscription.dispose()
        } catch (error) {
          logger.error('disposeSubscriptions', error)
        }
      }
    }
  }

  private stopMatrixClient(client: MatrixClient): Promise<void> {
    const pending = this.matrixStops.get(client)
    if (pending) {
      return pending
    }
    const stopping = client.stop()
    this.matrixStops.set(client, stopping)
    const finished = (): void => {
      if (this.matrixStops.get(client) === stopping) {
        this.matrixStops.delete(client)
      }
    }
    stopping.then(finished, finished)

    return stopping
  }

  private createReadiness(): ExposedPromise<MatrixClient> {
    const ready = new ExposedPromise<MatrixClient>()
    // A session can be stopped before anyone starts waiting for readiness.
    ready.promise.catch(() => undefined)

    return ready
  }

  private assertSession(session: MatrixSessionIdentity): void {
    if (!this.sessionActive || !this.isCurrentSession(session)) {
      throw new DOMException('Matrix session stopped', 'AbortError')
    }
  }

  private async getSessionClient(session: MatrixSessionIdentity): Promise<MatrixClient> {
    this.assertSession(session)
    const client = await session.ready.promise
    this.assertSession(session)

    return client
  }

  private waitForRetry(session: MatrixSessionIdentity, delay: number): Promise<void> {
    this.assertSession(session)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer)
        resolve()
      }, delay)
      this.retryTimers.set(timer, () =>
        reject(new DOMException('Matrix session stopped', 'AbortError'))
      )
    })
  }

  private captureSession(): MatrixSessionIdentity {
    return { id: this.session, ready: this.client }
  }

  private isCurrentSession(session: MatrixSessionIdentity): boolean {
    return session.id === this.session && session.ready === this.client
  }

  private writeSessionState(
    session: MatrixSessionIdentity,
    operation: () => Promise<void>
  ): Promise<void> {
    const commit = async (): Promise<void> => {
      if (this.isCurrentSession(session)) {
        await operation()
      }
    }
    this.sessionStateWrite = this.sessionStateWrite.then(commit, commit)

    return this.sessionStateWrite
  }

  private mutatePeerRooms(
    session: MatrixSessionIdentity,
    update: (rooms: Readonly<PeerRoomIds>) => PeerRoomIds
  ): Promise<void> {
    return this.writeSessionState(session, async () => {
      const rooms = await this.storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)
      if (!this.isCurrentSession(session)) {
        return
      }
      const updated = update(rooms)
      if (this.isCurrentSession(session)) {
        await this.storage.set(StorageKey.MATRIX_PEER_ROOM_IDS, updated)
      }
    })
  }

  public async tryJoinRooms(
    roomId: string,
    retry: number = 1,
    isAuthorized: () => Promise<boolean> = async () => true
  ): Promise<void> {
    const session = this.captureSession()
    const matrixClient = await session.ready.promise
    await this.joinRoomsForSession(roomId, retry, { ...session, matrixClient }, isAuthorized)
  }

  private async joinRoomsForSession(
    roomId: string,
    retry: number,
    session: MatrixJoinSession,
    isAuthorized: () => Promise<boolean>
  ): Promise<void> {
    if (!this.isCurrentSession(session)) {
      return
    }
    if (!(await isAuthorized()) || !this.isCurrentSession(session)) {
      return
    }
    try {
      await session.matrixClient.joinRooms(roomId)
    } catch (error: unknown) {
      if (!this.isCurrentSession(session)) {
        return
      }
      if (retry <= 10 && isMatrixError(error) && error.errcode === 'M_FORBIDDEN') {
        // Federated nodes can briefly reject a join immediately after an invite.
        logger.log('Retrying to join...', error)
        this.waitForRetry(session, 200)
          .then(() => this.joinRoomsForSession(roomId, retry + 1, session, isAuthorized))
          .catch((retryError) => {
            if (this.isCurrentSession(session)) {
              logger.error('tryJoinRooms', retryError)
            }
          })
      } else {
        logger.log(`Failed to join after ${retry} tries.`, error)
      }
    }
  }

  public start(): Promise<void> {
    if (this.stopping) {
      return this.stopping.then(
        () => this.start(),
        () => this.start()
      )
    }
    if (this.startup) {
      return this.startup
    }
    if (this.matrixClient && this.client.isResolved()) {
      return Promise.resolve()
    }

    if (this.client.status === ExposedPromiseStatus.REJECTED) {
      this.client = this.createReadiness()
      this.session = Symbol('Matrix session')
    }
    if (this.relayAbort.signal.aborted) {
      this.relayAbort = new AbortController()
    }
    this.sessionActive = true
    const completion = new ExposedPromise<void>()
    const pending = completion.promise
    this.startup = pending
    this.cancelStartup = () =>
      completion.reject(new DOMException('Matrix startup cancelled', 'AbortError'))
    this.startClient().then(
      () => {
        if (this.startup === pending) {
          this.startup = undefined
          this.cancelStartup = undefined
        }
        completion.resolve()
      },
      (error: unknown) => {
        if (this.startup === pending) {
          this.startup = undefined
          this.cancelStartup = undefined
          this.sessionActive = false
          this.relayAbort.abort()
          this.client.reject(error)
        }
        completion.reject(error)
      }
    )

    return pending
  }

  private async startClient(): Promise<void> {
    const generation = ++this.startupGeneration
    const owner = this.captureSession()
    const session = owner.id
    logger.log('start', 'starting client')

    logger.log('start', `connecting to server`)

    const relayServer: { server: string; timestamp: number } = await this.getRelayServer()
    if (generation !== this.startupGeneration || session !== this.session) {
      throw new DOMException('Matrix startup cancelled', 'AbortError')
    }

    const client = MatrixClient.create({
      baseUrl: `https://${relayServer.server}`,
      storage: this.storage
    })
    this.startingClient = client
    this.matrixClient = client
    client.onHealthTransition?.(async (event) => {
      if (!this.isCurrentSession(owner) || this.matrixClient !== client) {
        return
      }
      const onTransportStatus = this.eventHandlers.get(ClientEvents.TRANSPORT_STATUS)
      if (onTransportStatus) {
        await onTransportStatus({
          ...event,
          relayServer: this.currentRelayServer
        })
      }
    })

    const replay = this.initialReplay
    this.initialListener = async (
      event: MatrixClientEvent<MatrixClientEventType.MESSAGE>
    ): Promise<void> => {
      if (replay !== this.initialReplay || !this.isCurrentSession(owner)) {
        return
      }
      replay.buffered.add(event)
      if (this.initialEvent && this.initialEvent.timestamp && event && event.timestamp) {
        if (this.initialEvent.timestamp < event.timestamp) {
          this.initialEvent = event
        }
      } else {
        this.initialEvent = event
      }
    }
    this.subscribe(client, MatrixClientEventType.MESSAGE, this.initialListener)

    const handleInvite = async (
      event: MatrixClientEvent<MatrixClientEventType.INVITE>
    ): Promise<void> => {
      if (!this.isCurrentSession(owner)) {
        return
      }
      const pairingGeneration = this.pendingPairings.hasPending()
        ? this.pendingPairings.generation
        : undefined
      const ownId = recipientString(await this.getPublicKeyHash(), relayServer.server)
      if (!this.isCurrentSession(owner)) {
        return
      }
      const rejectedTargets =
        (event.content.invitations as { rejectedTargets?: string[] } | undefined)
          ?.rejectedTargets ?? []
      if (rejectedTargets.includes(ownId)) {
        return
      }
      const targetInvitations = (event.content.invitations ?? []).filter(
        ({ target }) => target === ownId
      )
      const uniqueInviters = Array.from(new Set(targetInvitations.map(({ sender }) => sender)))
      if (uniqueInviters.length !== 1) {
        return
      }
      const isAuthorized = async (): Promise<boolean> => {
        if (
          pairingGeneration !== undefined &&
          pairingGeneration === this.pendingPairings.generation &&
          this.pendingPairings.hasPending()
        ) {
          return true
        }
        const dappPeers = await this.storage.get(StorageKey.TRANSPORT_P2P_PEERS_DAPP)
        const walletPeers = await this.storage.get(StorageKey.TRANSPORT_P2P_PEERS_WALLET)

        return this.isAuthorizedPeerInviter(uniqueInviters[0], [
          ...(Array.isArray(dappPeers) ? dappPeers : []),
          ...(Array.isArray(walletPeers) ? walletPeers : [])
        ])
      }
      if ((await isAuthorized()) && this.isCurrentSession(owner)) {
        await this.tryJoinRooms(event.content.roomId, 1, isAuthorized)
      }
    }
    this.subscribe(client, MatrixClientEventType.INVITE, handleInvite)

    const keyPair = this.keyPair
    if (!keyPair) {
      throw new Error('Missing key pair')
    }
    let initialPasswordUsed = false
    const password = async (): Promise<string> => {
      const useFallback = !initialPasswordUsed
      initialPasswordUsed = true
      const timestamp = await this.getBeaconInfo(relayServer.server)
        .then((info) => info.timestamp)
        .catch((error) => {
          if (useFallback && Number.isFinite(relayServer.timestamp) && relayServer.timestamp > 0) {
            return relayServer.timestamp
          }
          throw error
        })
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        throw new Error('Invalid relay timestamp')
      }
      const loginString = `login:${Math.floor(timestamp / (5 * 60))}`
      const secretKey =
        keyPair.secretKey ?? (keyPair as unknown as { privateKey: Uint8Array }).privateKey
      const signature = sign(secretKey, hash(encode(loginString), 32))

      return `ed:${toHex(signature)}:${await this.getPublicKey()}`
    }
    try {
      const id = await this.getPublicKeyHash()
      if (generation !== this.startupGeneration || session !== this.session) {
        throw new DOMException('Matrix startup cancelled', 'AbortError')
      }
      await client.start({
        id,
        password,
        deviceId: toHex(keyPair.publicKey)
      })
    } catch (error: unknown) {
      return this.handleStartupFailure(client, owner, generation, error)
    }

    if (this.startingClient === client) {
      this.startingClient = undefined
    }
    if (generation !== this.startupGeneration || session !== this.session) {
      if (this.matrixClient === client) {
        this.matrixClient = undefined
      }
      await this.stopMatrixClient(client)
      throw new DOMException('Matrix startup cancelled', 'AbortError')
    }

    logger.log('start', 'login successful, client is ready')
    this.client.resolve(client)
  }

  private async handleStartupFailure(
    client: MatrixClient,
    owner: MatrixSessionIdentity,
    generation: number,
    error: unknown
  ): Promise<void> {
    const session = owner.id
    this.disposeSubscriptions(client)
    if (generation !== this.startupGeneration || session !== this.session) {
      throw new DOMException('Matrix startup cancelled', 'AbortError')
    }
    // Retain the resource until cleanup completes so stop joins this same disposal.
    await this.stopMatrixClient(client).catch((stopError) => logger.error(stopError))
    if (this.startingClient === client) {
      this.startingClient = undefined
    }
    if (this.matrixClient === client) {
      this.matrixClient = undefined
    }
    if (generation !== this.startupGeneration || session !== this.session) {
      throw new DOMException('Matrix startup cancelled', 'AbortError')
    }
    if (isAbortError(error)) {
      await this.resetSession(session)
      throw new DOMException('Matrix startup cancelled', 'AbortError')
    }
    logger.error('start', 'Could not log in, retrying', error)

    if (isMatrixError(error) && error.errcode === 'M_USER_DEACTIVATED') {
      await this.generateNewKeyPair(session)
      if (generation !== this.startupGeneration || session !== this.session) {
        throw new DOMException('Matrix startup cancelled', 'AbortError')
      }
      await this.resetSession(session)
      if (generation !== this.startupGeneration || session !== this.session) {
        throw new DOMException('Matrix startup cancelled', 'AbortError')
      }
      throw new Error('The account is deactivated.')
    }

    await this.resetSession(session)
    if (generation !== this.startupGeneration || session !== this.session) {
      throw new DOMException('Matrix startup cancelled', 'AbortError')
    }
    if (!this.selectedRegion) {
      throw new Error('No region selected.')
    }
    if (this.loginCounter <= (this.ENABLED_RELAY_SERVERS[this.selectedRegion] ?? []).length) {
      this.loginCounter++

      return this.startClient()
    } else {
      logger.error(
        'start',
        'Tried to log in to every known beacon node, but no login was successful.'
      )

      throw new Error('Could not connect to any beacon nodes. Try again later.')
    }
  }

  public stop(): Promise<void> {
    if (this.stopping) {
      return this.stopping
    }
    logger.log('stop', 'stopping client')
    ++this.startupGeneration
    this.sessionActive = false
    this.cancelStartup?.()
    this.cancelStartup = undefined
    this.startup = undefined
    const ready = this.client
    ready.reject(new DOMException('Matrix session stopped', 'AbortError'))
    const session = Symbol('Matrix session')
    this.session = session
    this.relayAbort.abort()
    this.relayServer?.reject(new DOMException('Matrix discovery cancelled', 'AbortError'))
    this.disposeSubscriptions()
    this.selectedRegion = undefined
    this.activeRelayServer = undefined
    this.loginCounter = 0
    const starting = this.startingClient
    const active = this.matrixClient
    this.startingClient = undefined
    this.matrixClient = undefined
    for (const [timer, cancel] of this.retryTimers) {
      clearTimeout(timer)
      cancel()
    }
    this.retryTimers.clear()

    const stopping = this.stopClient(session, starting, active, ready)
    this.stopping = stopping
    const finished = (): void => {
      if (this.stopping === stopping) {
        this.stopping = undefined
      }
    }
    stopping.then(finished, finished)

    return stopping
  }

  private async stopClient(
    session: symbol,
    starting: MatrixClient | undefined,
    active: MatrixClient | undefined,
    ready: ExposedPromise<MatrixClient>
  ): Promise<void> {
    try {
      await this.cancelPairingRequests()
    } finally {
      try {
        if (starting) {
          await this.stopMatrixClient(starting)
        }
      } finally {
        try {
          const client = active ?? (ready.isResolved() ? await ready.promise : undefined)
          if (client && client !== starting) {
            await this.stopMatrixClient(client).catch((error) => logger.error(error))
          }
        } finally {
          await this.resetSession(session)
        }
      }
    }
  }

  public async reset(): Promise<void> {
    await this.stop()
  }

  private async resetSession(session: symbol): Promise<void> {
    logger.log('reset', 'resetting connection')

    const owner = this.captureSession()
    if (session !== owner.id) {
      return
    }
    await this.writeSessionState(owner, async () => {
      for (const key of [
        StorageKey.MATRIX_PEER_ROOM_IDS,
        StorageKey.MATRIX_PRESERVED_STATE,
        StorageKey.MATRIX_SELECTED_NODE
      ]) {
        if (!this.isCurrentSession(owner)) {
          return
        }
        await this.storage.delete(key).catch((error) => logger.log(error))
      }
    })
    if (!this.isCurrentSession(owner)) {
      return
    }
    this.matrixClient = undefined

    this.relayServer = undefined
    this.client.reject(new DOMException('Matrix session stopped', 'AbortError'))
    this.client = this.createReadiness()
    this.ignoredRooms = []
    this.retireEncryptedMessageListeners()
    this.seenCiphertexts = new Set()
    this.inFlightCiphertexts = new Set()
  }

  private retireEncryptedMessageListeners(): void {
    this.activeListeners.clear()
    this.initialReplay = { pending: 0, buffered: new WeakSet(), claimed: new WeakSet() }
    this.initialEvent = undefined
    this.initialListener = undefined
  }

  public async listenForEncryptedMessage(
    senderPublicKey: string,
    messageCallback: (message: string) => void | Promise<void>
  ): Promise<void> {
    if (this.activeListeners.has(senderPublicKey)) {
      return
    }
    logger.log(
      'listenForEncryptedMessage',
      `start listening for encrypted messages from publicKey ${senderPublicKey}`
    )
    const replay = this.initialReplay
    const seenCiphertexts = this.seenCiphertexts
    const inFlightCiphertexts = this.inFlightCiphertexts
    const session = this.captureSession()
    replay.pending++
    let matrixClient: MatrixClient | undefined
    try {
      matrixClient = await this.client.promise
      if (replay !== this.initialReplay || !this.isCurrentSession(session)) {
        return
      }
      if (!this.keyPair) {
        throw new Error('Missing key pair')
      }
      const sharedKey = await this.createCryptoBoxServer(senderPublicKey, this.keyPair)
      if (replay !== this.initialReplay || !this.isCurrentSession(session)) {
        return
      }

      const callbackFunction = async (
        event: MatrixClientEvent<MatrixClientEventType.MESSAGE>
      ): Promise<void> => {
        if (replay !== this.initialReplay || !this.isCurrentSession(session)) {
          return
        }
        if (this.isTextMessage(event.content) && (await this.isSender(event, senderPublicKey))) {
          if (replay !== this.initialReplay || !this.isCurrentSession(session)) {
            return
          }
          const [, ...senderRelayParts] = event.content.message.sender.split(':')
          const senderRelay = senderRelayParts.join(':')
          const dappPeers = await this.storage.get(StorageKey.TRANSPORT_P2P_PEERS_DAPP)
          const walletPeers = await this.storage.get(StorageKey.TRANSPORT_P2P_PEERS_WALLET)
          const peers = [
            ...(Array.isArray(dappPeers) ? dappPeers : []),
            ...(Array.isArray(walletPeers) ? walletPeers : [])
          ]
          const matchingPeers = peers.filter((peer) => peer.publicKey === senderPublicKey)
          const trustedSenderRelay =
            matchingPeers.length === 0 ||
            matchingPeers.some((peer) => peer.relayServer === senderRelay) ||
            (await this.isTrustedRelayServer(senderRelay))
          if (
            !trustedSenderRelay ||
            replay !== this.initialReplay ||
            !this.isCurrentSession(session)
          ) {
            return
          }
          const rawContent = event.content.message.content
          if (
            typeof rawContent !== 'string' ||
            rawContent.length === 0 ||
            rawContent.length % 2 !== 0 ||
            !/^[0-9a-f]+$/i.test(rawContent)
          ) {
            return
          }
          const ciphertext = rawContent.toLowerCase()
          const payload = Buffer.from(ciphertext, 'hex')
          if (payload.length >= secretbox_NONCEBYTES + secretbox_MACBYTES) {
            let decryptedMessage: string
            try {
              decryptedMessage = await decryptCryptoboxPayload(payload, sharedKey.receive)
              if (replay !== this.initialReplay || !this.isCurrentSession(session)) {
                return
              }
              const message = (
                decryptedMessage.startsWith('{')
                  ? JSON.parse(decryptedMessage)
                  : await new Serializer().deserialize(decryptedMessage)
              ) as { senderId?: string }
              if (message.senderId !== (await getSenderId(senderPublicKey))) {
                return
              }
            } catch {
              // Some messages are encrypted for other recipients.
              return
            }
            if (replay !== this.initialReplay || !this.isCurrentSession(session)) {
              return
            }
            if (seenCiphertexts.has(ciphertext) || inFlightCiphertexts.has(ciphertext)) {
              return
            }
            inFlightCiphertexts.add(ciphertext)
            try {
              await this.updateRelayServer(event.content.message.sender)
              if (replay !== this.initialReplay || !this.isCurrentSession(session)) {
                return
              }
              await this.updatePeerRoom(event.content.message.sender, event.content.roomId)
              if (replay !== this.initialReplay || !this.isCurrentSession(session)) {
                return
              }
              if (replay.buffered.has(event)) {
                if (replay.claimed.has(event)) {
                  return
                }
                replay.claimed.add(event)
                if (this.initialEvent === event) {
                  this.initialEvent = undefined
                }
              }
              if (seenCiphertexts.size >= 1000) {
                const oldest = seenCiphertexts.values().next().value
                if (oldest !== undefined) {
                  seenCiphertexts.delete(oldest)
                }
              }
              seenCiphertexts.add(ciphertext)
              logger.log(
                'listenForEncryptedMessage',
                `received a message from ${senderPublicKey}`,
                decryptedMessage
              )
              if (this.isCurrentSession(session)) {
                await messageCallback(decryptedMessage)
              }
            } finally {
              inFlightCiphertexts.delete(ciphertext)
            }
          }
        }
      }
      this.activeListeners.set(senderPublicKey, callbackFunction)
      this.subscribe(matrixClient, MatrixClientEventType.MESSAGE, callbackFunction)

      const lastEvent = this.initialEvent
      if (lastEvent && lastEvent.timestamp && Date.now() - lastEvent.timestamp < 5 * 60 * 1000) {
        logger.log('listenForEncryptedMessage', 'Handling previous event')
        replay.buffered.add(lastEvent)
        await callbackFunction(lastEvent)
      } else {
        logger.log('listenForEncryptedMessage', 'No previous event found')
      }
    } finally {
      replay.pending--
      if (matrixClient && replay === this.initialReplay && replay.pending === 0) {
        if (this.initialListener) {
          this.unsubscribe(matrixClient, MatrixClientEventType.MESSAGE, this.initialListener)
        }
        this.initialListener = undefined
        this.initialEvent = undefined
      }
    }
  }

  public async unsubscribeFromEncryptedMessage(senderPublicKey: string): Promise<void> {
    const listener = this.activeListeners.get(senderPublicKey)
    if (!listener) {
      return
    }
    const session = this.captureSession()
    const client = await session.ready.promise
    if (!this.isCurrentSession(session)) {
      return
    }
    this.unsubscribe(client, MatrixClientEventType.MESSAGE, listener)
    if (this.activeListeners.get(senderPublicKey) === listener) {
      this.activeListeners.delete(senderPublicKey)
    }
  }

  public async unsubscribeFromEncryptedMessages(): Promise<void> {
    // A transport that never started has no listeners, but its readiness can stay pending forever.
    this.retireEncryptedMessageListeners()
    for (const subscription of this.subscriptions) {
      if (subscription.event === MatrixClientEventType.MESSAGE) {
        subscription.dispose()
      }
    }
  }

  public async sendMessage(
    message: string,
    peer: P2PPairingRequest | ExtendedP2PPairingResponse
  ): Promise<void> {
    const session = this.captureSession()
    this.assertSession(session)
    const sharedKey = await this.createCryptoBoxClient(peer.publicKey, this.getKeyPair())
    this.assertSession(session)
    const recipientHash = await getHexHash(Buffer.from(peer.publicKey, 'hex'))
    this.assertSession(session)
    const recipient = recipientString(recipientHash, peer.relayServer)
    const roomId = await this.getRelevantRoom(recipient, session)
    this.assertSession(session)
    const encryptedMessage = await encryptCryptoboxPayload(message, sharedKey.send)
    const client = await this.getSessionClient(session)
    this.assertSession(session)

    logger.log('sendMessage', 'sending encrypted message', peer.publicKey, roomId, message)
    try {
      await client.sendTextMessage(roomId, encryptedMessage)
    } catch (error) {
      this.assertSession(session)
      if (isMatrixError(error) && error.errcode === 'M_FORBIDDEN') {
        await this.deleteRoomIdFromRooms(roomId)
        this.assertSession(session)
        const newRoomId = await this.getRelevantRoom(recipient, session)
        this.assertSession(session)
        await client.sendTextMessage(newRoomId, encryptedMessage)
      } else {
        throw error
      }
    }
  }

  public async updatePeerRoom(sender: string, roomId: string): Promise<void> {
    const session = this.captureSession()
    logger.log('updatePeerRoom', sender, roomId)
    const split = sender.split(':')
    if (split.length < 2 || !split[0].startsWith('@')) {
      return Promise.reject(new Error('Invalid sender'))
    }

    return this.mutatePeerRooms(session, (roomIds) => {
      const room = roomIds[sender]
      logger.debug('updatePeerRoom', 'current room', room, 'new room', roomId)
      if (room && room !== roomId) {
        logger.log('updatePeerRoom', `adding room "${room}" to ignored array`)
        this.ignoredRooms.push(room)
      }

      return { ...roomIds, [sender]: roomId }
    })
  }

  public async deleteRoomIdFromRooms(roomId: string): Promise<void> {
    const session = this.captureSession()
    await this.mutatePeerRooms(session, (roomIds) => {
      const remaining: PeerRoomIds = {}
      for (const [sender, knownRoom] of Object.entries(roomIds)) {
        if (knownRoom !== roomId) {
          remaining[sender] = knownRoom
        }
      }

      return remaining
    })
    if (this.isCurrentSession(session)) {
      this.ignoredRooms.push(roomId)
    }
  }

  private isValidPairingResponseShape(response: unknown): response is P2PPairingResponse {
    if (!response || typeof response !== 'object') {
      return false
    }
    const candidate = response as Partial<P2PPairingResponse>

    return (
      typeof candidate.id === 'string' &&
      typeof candidate.publicKey === 'string' &&
      /^[a-f0-9]{64}$/i.test(candidate.publicKey) &&
      typeof candidate.name === 'string' &&
      typeof candidate.version === 'string'
    )
  }

  public async listenForChannelOpening(
    messageCallback: (
      pairingResponse: ExtendedP2PPairingResponse,
      isActive: () => boolean
    ) => void | Promise<void>
  ): Promise<void> {
    logger.debug('listenForChannelOpening')
    const session = this.captureSession()
    const client = await session.ready.promise
    if (!this.isCurrentSession(session)) {
      return
    }
    this.subscribe(client, MatrixClientEventType.MESSAGE, async (event) => {
      if (!this.isCurrentSession(session) || !this.isTextMessage(event.content)) {
        return
      }
      const content = { ...event.content, message: { ...event.content.message } }
      if (!(await this.isChannelOpenMessage(content)) || !this.isCurrentSession(session)) {
        return
      }
      logger.log(
        'listenForChannelOpening',
        'channel opening received, trying to decrypt',
        JSON.stringify(event)
      )

      const splits = content.message.content.split(':')
      const hexPayload = splits[splits.length - 1]
      if (!hexPayload || hexPayload.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hexPayload)) {
        return
      }
      const payload = Buffer.from(hexPayload, 'hex')

      if (payload.length >= secretbox_NONCEBYTES + secretbox_MACBYTES) {
        let response: ExtendedP2PPairingResponse
        try {
          const keyPair = this.keyPair
          if (!keyPair) {
            return
          }
          const plaintext = await openCryptobox(payload, keyPair.publicKey, keyPair.secretKey)
          if (!this.isCurrentSession(session)) {
            return
          }
          const pairingResponse: unknown = JSON.parse(plaintext)

          logger.log(
            'listenForChannelOpening',
            'channel opening received and decrypted',
            JSON.stringify(pairingResponse)
          )

          if (
            !this.isValidPairingResponseShape(pairingResponse) ||
            !(await this.isSender(event, pairingResponse.publicKey)) ||
            !this.isCurrentSession(session)
          ) {
            return
          }
          const senderId = await getSenderId(pairingResponse.publicKey)
          if (!this.isCurrentSession(session)) {
            return
          }
          response = {
            ...pairingResponse,
            relayServer: content.message.sender.split(':').slice(1).join(':'),
            senderId
          }
        } catch {
          // Some channel messages are encrypted for other recipients.
          return
        }
        if (this.isCurrentSession(session)) {
          await this.pendingPairings.accept(response.id, async (isActive) => {
            if (this.isCurrentSession(session)) {
              await messageCallback(response, isActive)
            }
          })
        }
      }
    })
  }

  public async waitForJoin(roomId: string, retry: number = 0): Promise<void> {
    const session = this.captureSession()
    const client = await this.getSessionClient(session)
    await this.waitForSessionJoin(roomId, retry, session, client)
  }

  private async waitForSessionJoin(
    roomId: string,
    retry: number,
    session: MatrixSessionIdentity,
    client: MatrixClient
  ): Promise<void> {
    this.assertSession(session)
    const room = await client.getRoomById(roomId)
    this.assertSession(session)
    if (room.members.length >= 2) {
      return
    }
    if (retry > 200) {
      throw new Error(`No one joined after ${retry} tries.`)
    }
    await this.waitForRetry(session, 100 * (retry > 50 ? 10 : 1))
    await this.waitForSessionJoin(roomId, retry + 1, session, client)
  }

  public async sendPairingResponse(pairingRequest: P2PPairingRequest): Promise<void> {
    const session = this.captureSession()
    this.assertSession(session)
    const recipientHash = await getHexHash(Buffer.from(pairingRequest.publicKey, 'hex'))
    this.assertSession(session)
    const recipient = recipientString(recipientHash, pairingRequest.relayServer)
    const client = await this.getSessionClient(session)
    this.assertSession(session)
    const roomId = await client.createTrustedPrivateRoom(recipient)
    this.assertSession(session)
    await this.updatePeerRoom(recipient, roomId)
    this.assertSession(session)
    await this.waitForJoin(roomId)
    this.assertSession(session)

    const message =
      typeof pairingRequest.version === 'undefined'
        ? await this.getPublicKey()
        : JSON.stringify(await this.getPairingResponseInfo(pairingRequest))
    this.assertSession(session)
    const encryptedMessage = await this.encryptMessageAsymmetric(pairingRequest.publicKey, message)
    this.assertSession(session)
    const msg = ['@channel-open', recipient, encryptedMessage].join(':')
    await client.sendTextMessage(roomId, msg).catch(async (error: unknown) => {
      this.assertSession(session)
      if (isMatrixError(error) && error.errcode === 'M_FORBIDDEN') {
        await this.deleteRoomIdFromRooms(roomId)
        this.assertSession(session)
        const newRoomId = await this.getRelevantRoom(recipient, session)
        this.assertSession(session)
        await client.sendTextMessage(newRoomId, msg).catch((retryError: unknown) => {
          logger.log('sendPairingResponse', 'inner error', newRoomId, retryError)
        })
      } else {
        logger.log('sendPairingResponse', 'unexpected error', error)
      }
    })
  }

  public isTextMessage(
    content: MatrixClientEventMessageContent<unknown>
  ): content is MatrixClientEventMessageContent<string> {
    return (
      content.message.type === MatrixMessageType.TEXT && typeof content.message.content === 'string'
    )
  }

  public async updateRelayServer(sender: string): Promise<void> {
    const session = this.captureSession()
    logger.log('updateRelayServer', sender)
    const split = sender.split(':')
    if (split.length < 2 || !split[0].startsWith('@')) {
      return Promise.reject(new Error('Invalid sender'))
    }
    const senderHash = split.shift()
    const relayServer = split.join(':')

    return this.writeSessionState(session, async () => {
      const dappManager = new PeerManager(this.storage, StorageKey.TRANSPORT_P2P_PEERS_DAPP)
      const dappPeers = await dappManager.getPeers()
      if (!this.isCurrentSession(session)) {
        return
      }
      if (Array.isArray(dappPeers)) {
        for (const peer of dappPeers) {
          const peerHash = `@${await getHexHash(Buffer.from(peer.publicKey, 'hex'))}`
          if (!this.isCurrentSession(session)) {
            return
          }
          if (peerHash === senderHash && peer.relayServer !== relayServer) {
            await dappManager.addPeer({ ...peer, relayServer })
          }
        }
      }

      const walletManager = new PeerManager(this.storage, StorageKey.TRANSPORT_P2P_PEERS_WALLET)
      const walletPeers = await walletManager.getPeers()
      if (!this.isCurrentSession(session)) {
        return
      }
      if (Array.isArray(walletPeers)) {
        for (const peer of walletPeers) {
          const peerHash = `@${await getHexHash(Buffer.from(peer.publicKey, 'hex'))}`
          if (!this.isCurrentSession(session)) {
            return
          }
          if (peerHash === senderHash && peer.relayServer !== relayServer) {
            await walletManager.addPeer({ ...peer, relayServer })
          }
        }
      }
    })
  }

  public async isChannelOpenMessage(
    content: MatrixClientEventMessageContent<string>
  ): Promise<boolean> {
    return content.message.content.startsWith(
      `@channel-open:@${await getHexHash(Buffer.from(await this.getPublicKey(), 'hex'))}`
    )
  }

  public async isSender(
    event: MatrixClientEvent<MatrixClientEventType.MESSAGE>,
    senderPublicKey: string
  ): Promise<boolean> {
    return event.content.message.sender.startsWith(
      `@${await getHexHash(Buffer.from(senderPublicKey, 'hex'))}:`
    )
  }

  private async generateNewKeyPair(session: symbol): Promise<void> {
    const newSeed = await generateGUID()
    if (session !== this.session) {
      return
    }

    console.warn(`The current user ID has been deactivated. Generating new ID: ${newSeed}`)

    await this.storage.set(StorageKey.BEACON_SDK_SECRET_SEED, newSeed)
    if (session !== this.session) {
      return
    }
    const keyPair = await getKeypairFromSeed(newSeed)
    if (session === this.session) {
      this.keyPair = keyPair
    }
  }

  private async getRelevantRoom(
    recipient: string,
    session = this.captureSession()
  ): Promise<string> {
    this.assertSession(session)
    const roomIds = await this.storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)
    this.assertSession(session)
    let roomId = roomIds[recipient]
    if (!roomId) {
      const room = await this.getRelevantJoinedRoom(recipient, session)
      this.assertSession(session)
      roomId = room.id
      await this.mutatePeerRooms(session, (current) => ({ ...current, [recipient]: room.id }))
      this.assertSession(session)
    }

    return roomId
  }

  private async getRelevantJoinedRoom(
    recipient: string,
    session = this.captureSession()
  ): Promise<MatrixRoom> {
    const client = await this.getSessionClient(session)
    this.assertSession(session)
    const joinedRooms = await client.joinedRooms
    this.assertSession(session)
    const relevantRooms = joinedRooms
      .filter((room) => !this.ignoredRooms.includes(room.id))
      .filter((room) => room.members.includes(recipient))

    // An ignored room indicates that the stored sync state is no longer reusable.
    if (relevantRooms.length === 0 || this.ignoredRooms.length > 0) {
      const roomId = await client.createTrustedPrivateRoom(recipient)
      this.assertSession(session)
      const room = await client.getRoomById(roomId)
      this.assertSession(session)
      await this.waitForJoin(roomId)
      this.assertSession(session)

      return room
    }

    return relevantRooms[0]
  }
}
