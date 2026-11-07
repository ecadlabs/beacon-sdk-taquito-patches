import {
  ExposedPromise,
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
  PeerManager,
  BEACON_VERSION,
  getSenderId,
  Logger,
  CommunicationClient
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

const sleep = (time: number) => new Promise((resolve) => setTimeout(resolve, time))

const isMatrixError = (error: unknown): error is { errcode: string } =>
  typeof error === 'object' &&
  error !== null &&
  'errcode' in error &&
  typeof error.errcode === 'string'

/**
 * @internalapi
 */
export class P2PCommunicationClient extends CommunicationClient {
  private client: ExposedPromise<MatrixClient> = new ExposedPromise()

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
  public relayServer:
    ExposedPromise<{ server: string; timestamp: number; localTimestamp: number }> | undefined

  private readonly activeListeners: Map<
    string,
    (event: MatrixClientEvent<MatrixClientEventType.MESSAGE>) => void
  > = new Map()

  private ignoredRooms: string[] = []
  private loginCounter: number = 0

  constructor(
    private readonly name: string,
    keyPair: KeyPair,
    public readonly replicationCount: number,
    private readonly storage: Storage,
    matrixNodes?: NodeDistributions,
    private readonly iconUrl?: string,
    private readonly appUrl?: string
  ) {
    super(keyPair)

    logger.log('constructor', 'P2PCommunicationClient created')

    this.ENABLED_RELAY_SERVERS = REGIONS_AND_SERVERS

    if (matrixNodes) {
      this.ENABLED_RELAY_SERVERS = {
        ...REGIONS_AND_SERVERS,
        ...matrixNodes
      }
    }
  }

  public async getPairingRequestInfo(): Promise<P2PPairingRequest> {
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
    if (this.selectedRegion) {
      return this.relayServer?.promiseResult
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
    await Promise.race([Promise.all(probePromises), sleep(RESPONSE_WAIT_TIME_MS)])

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
    const session = this.session
    // Fast path: in-memory cached relay server that's still fresh
    if (this.relayServer) {
      const currentPromise = this.relayServer
      const relayServer = await this.relayServer.promise

      if (Date.now() - relayServer.localTimestamp < 60 * 1000) {
        return { server: relayServer.server, timestamp: relayServer.timestamp }
      }

      try {
        const info = await this.getBeaconInfo(relayServer.server)
        const refreshedPromise = ExposedPromise.resolve({
          server: relayServer.server,
          timestamp: info.timestamp,
          localTimestamp: new Date().getTime()
        })

        if (this.relayServer === currentPromise) {
          this.relayServer = refreshedPromise
        }

        return { server: relayServer.server, timestamp: info.timestamp }
      } catch (error) {
        logger.log(
          'getRelayServer',
          `cached server ${relayServer.server} is unreachable, resetting`
        )
        if (session === this.session) {
          await this.storage.delete(StorageKey.MATRIX_SELECTED_NODE).catch((e) => logger.log(e))
        }
        const replacementRelayPromise = this.relayServer
        if (session === this.session && replacementRelayPromise === currentPromise) {
          this.relayServer = undefined
          this.selectedRegion = undefined
        } else if (replacementRelayPromise) {
          const latestRelayServer = await replacementRelayPromise.promise

          return { server: latestRelayServer.server, timestamp: latestRelayServer.timestamp }
        }
        // Fall through to discovery below
      }
    }

    if (this.relayServer) {
      const relayServer = await this.relayServer.promise

      return { server: relayServer.server, timestamp: relayServer.timestamp }
    }

    // First caller creates the promise; concurrent callers will await it at line above
    const discoveryPromise = new ExposedPromise<{
      server: string
      timestamp: number
      localTimestamp: number
    }>()
    if (session === this.session) {
      this.relayServer = discoveryPromise
    }

    try {
      // Try the localStorage-cached node first
      const node = await this.storage.get(StorageKey.MATRIX_SELECTED_NODE)
      if (node && node.length > 0) {
        try {
          const info = await this.getBeaconInfo(node)
          discoveryPromise.resolve({
            server: node,
            timestamp: info.timestamp,
            localTimestamp: new Date().getTime()
          })

          return { server: node, timestamp: info.timestamp }
        } catch (error) {
          logger.log(
            'getRelayServer',
            `stored node ${node} is unreachable, falling through to discovery`
          )
          if (session === this.session) {
            await this.storage.delete(StorageKey.MATRIX_SELECTED_NODE).catch((e) => logger.log(e))
          }
        }
      }

      // Full discovery: probe all servers, pick the fastest
      const server = await this.findBestRegionAndGetServer(session)

      if (!server) {
        throw new Error('No servers found')
      }

      if (session === this.session && this.relayServer === discoveryPromise) {
        this.storage
          .set(StorageKey.MATRIX_SELECTED_NODE, server.server)
          .catch((error) => logger.log(error))
      }

      discoveryPromise.resolve({
        server: server.server,
        timestamp: server.timestamp,
        localTimestamp: new Date().getTime()
      })

      return { server: server.server, timestamp: server.timestamp }
    } catch (error) {
      // Always settle the ExposedPromise so concurrent callers don't hang forever
      discoveryPromise.reject(error)
      if (session === this.session && this.relayServer === discoveryPromise) {
        this.relayServer = undefined
      }
      throw error
    }
  }

  public async getBeaconInfo(server: string): Promise<BeaconInfoResponse> {
    const response = await fetch(`https://${server}/_synapse/client/beacon/info`, {
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) {
      throw new Error(`getBeaconInfo ${server} failed: ${response.status} ${response.statusText}`)
    }
    const data = (await response.json()) as BeaconInfoResponse

    return {
      region: data.region,
      known_servers: data.known_servers,
      timestamp: Math.floor(data.timestamp)
    }
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

  public async tryJoinRooms(roomId: string, retry: number = 1): Promise<void> {
    const session = this.captureSession()
    const matrixClient = await session.ready.promise
    await this.joinRoomsForSession(roomId, retry, { ...session, matrixClient })
  }

  private async joinRoomsForSession(
    roomId: string,
    retry: number,
    session: MatrixJoinSession
  ): Promise<void> {
    if (!this.isCurrentSession(session)) {
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
        setTimeout(() => {
          this.joinRoomsForSession(roomId, retry + 1, session).catch((retryError) => {
            logger.error('tryJoinRooms', retryError)
          })
        }, 200)
      } else {
        logger.log(`Failed to join after ${retry} tries.`, error)
      }
    }
  }

  public async start(): Promise<void> {
    const owner = this.captureSession()
    const session = owner.id
    logger.log('start', 'starting client')

    logger.log('start', `connecting to server`)

    const relayServer: { server: string; timestamp: number } = await this.getRelayServer()
    if (session !== this.session) {
      return
    }

    const client = MatrixClient.create({
      baseUrl: `https://${relayServer.server}`,
      storage: this.storage
    })
    this.matrixClient = client

    const replay = this.initialReplay
    this.initialListener = async (
      event: MatrixClientEvent<MatrixClientEventType.MESSAGE>
    ): Promise<void> => {
      if (replay !== this.initialReplay) {
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
    client.subscribe(MatrixClientEventType.MESSAGE, this.initialListener)

    client.subscribe(MatrixClientEventType.INVITE, async (event) => {
      if (!this.isCurrentSession(owner)) {
        return
      }
      const { roomId, members } = event.content
      const member = members.length === 1 ? members[0] : undefined
      await this.tryJoinRooms(roomId)
      if (!this.isCurrentSession(owner)) {
        return
      }
      if (member) {
        await this.updateRelayServer(member)
        if (this.isCurrentSession(owner)) {
          await this.updatePeerRoom(member, roomId)
        }
      }
    })

    if (!relayServer.timestamp) {
      throw new Error('No timestamp received from relay server')
    }

    const time = Math.floor(relayServer.timestamp)

    const loginString = `login:${Math.floor(time / (5 * 60))}`

    logger.log(
      'start',
      `login ${loginString}, ${await this.getPublicKeyHash()} on ${relayServer.server}`
    )

    const loginRawDigest = hash(encode(loginString), 32)

    const keyPair = this.keyPair
    if (!keyPair) {
      throw new Error('Missing key pair')
    }
    const rawSignature = sign(keyPair.secretKey, loginRawDigest)

    const login = {
      id: await this.getPublicKeyHash(),
      password: `ed:${toHex(rawSignature)}:${await this.getPublicKey()}`,
      deviceId: toHex(keyPair.publicKey)
    }
    if (session !== this.session) {
      return
    }
    try {
      await client.start(login)
    } catch (error: unknown) {
      if (session !== this.session) {
        return
      }
      logger.error('start', 'Could not log in, retrying', error)

      if (isMatrixError(error) && error.errcode === 'M_USER_DEACTIVATED') {
        await this.generateNewKeyPair(session)
        if (session !== this.session) {
          return
        }
        await this.resetSession(session)
        if (session !== this.session) {
          return
        }
        throw new Error('The account is deactivated.')
      }

      await client.stop()
      await this.resetSession(session)
      if (session !== this.session) {
        return
      }
      if (!this.selectedRegion) {
        throw new Error('No region selected.')
      }
      if (this.loginCounter <= (this.ENABLED_RELAY_SERVERS[this.selectedRegion] ?? []).length) {
        this.loginCounter++

        return this.start()
      } else {
        logger.error(
          'start',
          'Tried to log in to every known beacon node, but no login was successful.'
        )

        throw new Error('Could not connect to any beacon nodes. Try again later.')
      }
    }

    if (session !== this.session) {
      return
    }
    logger.log('start', 'login successful, client is ready')
    this.client.resolve(client)
  }

  public async stop(): Promise<void> {
    logger.log('stop', 'stopping client')
    const session = Symbol('Matrix session')
    this.session = session
    const client =
      this.matrixClient ?? (this.client.isResolved() ? await this.client.promise : undefined)
    this.matrixClient = undefined
    if (client) {
      await client.stop().catch((error) => logger.error(error))
    }
    await this.resetSession(session)
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

    // Instead of resetting everything, maybe we should make sure a new instance is created?
    this.relayServer = undefined
    this.client = new ExposedPromise()
    this.activeListeners.clear()
    this.ignoredRooms = []
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
          let payload
          await this.updateRelayServer(event.content.message.sender)
          if (replay !== this.initialReplay || !this.isCurrentSession(session)) {
            return
          }
          await this.updatePeerRoom(event.content.message.sender, event.content.roomId)
          if (replay !== this.initialReplay || !this.isCurrentSession(session)) {
            return
          }
          try {
            payload = Buffer.from(event.content.message.content, 'hex')
          } catch {
            // Connection-open requests may contain non-hex content.
          }
          if (payload && payload.length >= secretbox_NONCEBYTES + secretbox_MACBYTES) {
            let decryptedMessage: string
            try {
              decryptedMessage = await decryptCryptoboxPayload(payload, sharedKey.receive)
            } catch {
              // Some messages are encrypted for other recipients.
              return
            }
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
            logger.log(
              'listenForEncryptedMessage',
              `received a message from ${senderPublicKey}`,
              decryptedMessage
            )
            if (this.isCurrentSession(session)) {
              await messageCallback(decryptedMessage)
            }
          }
        }
      }
      this.activeListeners.set(senderPublicKey, callbackFunction)
      matrixClient.subscribe(MatrixClientEventType.MESSAGE, callbackFunction)

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
          matrixClient.unsubscribe(MatrixClientEventType.MESSAGE, this.initialListener)
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

    ;(await this.client.promise).unsubscribe(MatrixClientEventType.MESSAGE, listener)

    this.activeListeners.delete(senderPublicKey)
  }

  public async unsubscribeFromEncryptedMessages(): Promise<void> {
    ;(await this.client.promise).unsubscribeAll(MatrixClientEventType.MESSAGE)

    this.activeListeners.clear()
  }

  public async sendMessage(
    message: string,
    peer: P2PPairingRequest | ExtendedP2PPairingResponse
  ): Promise<void> {
    const sharedKey = await this.createCryptoBoxClient(peer.publicKey, this.keyPair!)

    const recipientHash: string = await getHexHash(Buffer.from(peer.publicKey, 'hex'))
    const recipient = recipientString(recipientHash, peer.relayServer)

    const roomId = await this.getRelevantRoom(recipient)

    // Before we send the message, we have to wait for the join to be accepted.
    // await this.waitForJoin(roomId) // TODO: This can probably be removed because we are now waiting inside the get room method

    const encryptedMessage = await encryptCryptoboxPayload(message, sharedKey.send)

    logger.log('sendMessage', 'sending encrypted message', peer.publicKey, roomId, message)
    try {
      await (await this.client.promise).sendTextMessage(roomId, encryptedMessage)
    } catch (error) {
      const errcode = isMatrixError(error) ? error.errcode : undefined
      if (errcode === 'M_FORBIDDEN') {
        // Room doesn't exist
        logger.log(`sendMessage`, `M_FORBIDDEN`, roomId, error)
        await this.deleteRoomIdFromRooms(roomId)
        const newRoomId = await this.getRelevantRoom(recipient)
        logger.log(`sendMessage`, `Old room deleted, new room created`, newRoomId)
        try {
          await (await this.client.promise).sendTextMessage(newRoomId, encryptedMessage)
        } catch (error2) {
          logger.log(`sendMessage`, `inner error`, newRoomId, error2)
          throw error2
        }
      } else {
        logger.log(`sendMessage`, `unexpected error`, error)
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

  public async listenForChannelOpening(
    messageCallback: (pairingResponse: ExtendedP2PPairingResponse) => void | Promise<void>
  ): Promise<void> {
    logger.debug('listenForChannelOpening')
    const session = this.captureSession()
    const client = await session.ready.promise
    if (!this.isCurrentSession(session)) {
      return
    }
    client.subscribe(MatrixClientEventType.MESSAGE, async (event) => {
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
      if (!this.isCurrentSession(session)) {
        return
      }
      await this.updateRelayServer(content.message.sender)
      if (!this.isCurrentSession(session)) {
        return
      }
      await this.updatePeerRoom(content.message.sender, content.roomId)
      if (!this.isCurrentSession(session)) {
        return
      }
      const splits = content.message.content.split(':')
      const payload = Buffer.from(splits[splits.length - 1], 'hex')
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
          const pairingResponse: P2PPairingResponse = JSON.parse(plaintext)
          logger.log(
            'listenForChannelOpening',
            'channel opening received and decrypted',
            JSON.stringify(pairingResponse)
          )
          const senderId = await getSenderId(pairingResponse.publicKey)
          response = { ...pairingResponse, senderId }
        } catch {
          // Some channel messages are encrypted for other recipients.
          return
        }
        if (this.isCurrentSession(session)) {
          await messageCallback(response)
        }
      }
    })
  }

  public async waitForJoin(roomId: string, retry: number = 0): Promise<void> {
    // Rooms are updated as new events come in. `client.getRoomById` only accesses memory, it does not do any network requests.
    // TODO: Improve to listen to "JOIN" event
    const room = await (await this.client.promise).getRoomById(roomId)
    logger.log(`waitForJoin`, `Currently ${room.members.length} members, we need at least 2`)
    if (room.members.length >= 2) {
      return
    } else {
      if (retry <= 200) {
        // On mobile, due to app switching, we potentially have to wait for a long time
        logger.log(`Waiting for join... Try: ${retry}`)

        return new Promise((resolve) => {
          setTimeout(
            () => {
              resolve(this.waitForJoin(roomId, retry + 1))
            },
            100 * (retry > 50 ? 10 : 1)
          ) // After the initial 5 seconds, retry only once per second
        })
      } else {
        throw new Error(`No one joined after ${retry} tries.`)
      }
    }
  }

  public async sendPairingResponse(pairingRequest: P2PPairingRequest): Promise<void> {
    logger.log(`sendPairingResponse`)
    const recipientHash = await getHexHash(Buffer.from(pairingRequest.publicKey, 'hex'))
    const recipient = recipientString(recipientHash, pairingRequest.relayServer)

    // We force room creation here because if we "re-pair", we need to make sure that we don't send it to an old room.
    const roomId = await (await this.client.promise).createTrustedPrivateRoom(recipient)
    logger.debug(`sendPairingResponse`, `Connecting to room "${roomId}"`)

    await this.updatePeerRoom(recipient, roomId)

    // Before we send the message, we have to wait for the join to be accepted.
    await this.waitForJoin(roomId) // TODO: This can probably be removed because we are now waiting inside the get room method

    logger.debug(`sendPairingResponse`, `Successfully joined room.`)

    // TODO: remove v1 backwards-compatibility
    const message: string =
      typeof pairingRequest.version === 'undefined'
        ? await this.getPublicKey() // v1
        : JSON.stringify(await this.getPairingResponseInfo(pairingRequest)) // v2

    logger.debug(`sendPairingResponse`, `Sending pairing response`, message)

    const encryptedMessage: string = await this.encryptMessageAsymmetric(
      pairingRequest.publicKey,
      message
    )

    const msg = ['@channel-open', recipient, encryptedMessage].join(':')
    await (await this.client.promise).sendTextMessage(roomId, msg).catch(async (error) => {
      if (error.errcode === 'M_FORBIDDEN') {
        // Room doesn't exist
        logger.log(`sendPairingResponse`, `M_FORBIDDEN`, roomId, error)
        await this.deleteRoomIdFromRooms(roomId)
        const newRoomId = await this.getRelevantRoom(recipient)
        logger.log(`sendPairingResponse`, `Old room deleted, new room created`, newRoomId)
        await (await this.client.promise).sendTextMessage(newRoomId, msg).catch(async (error2) => {
          logger.log(`sendPairingResponse`, `inner error`, newRoomId, error2)
        })
      } else {
        logger.log(`sendPairingResponse`, `unexpected error`, error)
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
      const dappPeers = await this.storage.get(StorageKey.TRANSPORT_P2P_PEERS_DAPP)
      const manager = new PeerManager(
        this.storage,
        dappPeers?.length
          ? StorageKey.TRANSPORT_P2P_PEERS_DAPP
          : StorageKey.TRANSPORT_P2P_PEERS_WALLET
      )
      const peers = await manager.getPeers()
      for (const peer of peers) {
        const peerHash = `@${await getHexHash(Buffer.from(peer.publicKey, 'hex'))}`
        if (!this.isCurrentSession(session)) {
          return
        }
        if (peerHash === senderHash && peer.relayServer !== relayServer) {
          await manager.addPeer({ ...peer, relayServer })
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
      `@${await getHexHash(Buffer.from(senderPublicKey, 'hex'))}`
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

  private async getRelevantRoom(recipient: string): Promise<string> {
    const session = this.captureSession()
    const roomIds = await this.storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)
    let roomId = roomIds[recipient]

    if (!roomId) {
      logger.log(`getRelevantRoom`, `No room found for peer ${recipient}, checking joined ones.`)
      const room = await this.getRelevantJoinedRoom(recipient)
      roomId = room.id
      await this.mutatePeerRooms(session, (current) => ({ ...current, [recipient]: room.id }))
    }

    logger.log(`getRelevantRoom`, `Using room ${roomId}`)

    return roomId
  }

  private async getRelevantJoinedRoom(recipient: string): Promise<MatrixRoom> {
    const joinedRooms = await (await this.client.promise).joinedRooms
    logger.log('checking joined rooms', joinedRooms, recipient)
    const relevantRooms = joinedRooms
      .filter((roomElement: MatrixRoom) => !this.ignoredRooms.some((id) => roomElement.id === id))
      .filter((roomElement: MatrixRoom) =>
        roomElement.members.some((member: string) => member === recipient)
      )

    let room: MatrixRoom
    // We always create a new room if one has been ignored. This is because if we ignore one, we know the server state changed.
    // So we cannot trust the current sync state. This can be removed once we have a method to properly clear and refresh the sync state.
    if (relevantRooms.length === 0 || this.ignoredRooms.length > 0) {
      logger.log(`getRelevantJoinedRoom`, `no relevant rooms found, creating new one`)

      const roomId = await (await this.client.promise).createTrustedPrivateRoom(recipient)
      room = await (await this.client.promise).getRoomById(roomId)
      logger.log(`getRelevantJoinedRoom`, `waiting for other party to join room: ${room.id}`)
      await this.waitForJoin(roomId)
      logger.log(`getRelevantJoinedRoom`, `new room created and peer invited: ${room.id}`)
    } else {
      room = relevantRooms[0]
      logger.log(`getRelevantJoinedRoom`, `channel already open, reusing room ${room.id}`)
    }

    return room
  }
}
