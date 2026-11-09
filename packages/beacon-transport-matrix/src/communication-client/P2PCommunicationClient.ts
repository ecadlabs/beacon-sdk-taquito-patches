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
  public cancelPairingRequests(): Promise<void> {
    return this.pendingPairings.cancel()
  }

  private startingClient: MatrixClient | undefined
  private startupGeneration = 0
  private resetting?: Promise<void>

  private client: ExposedPromise<MatrixClient> = new ExposedPromise()

  private initialEvent: MatrixClientEvent<MatrixClientEventType.MESSAGE> | undefined
  private initialListener:
    | ((event: MatrixClientEvent<MatrixClientEventType.MESSAGE>) => void)
    | undefined

  private selectedRegion?: Regions
  private readonly ENABLED_RELAY_SERVERS: NodeDistributions
  public relayServer:
    | ExposedPromise<{ server: string; timestamp: number; localTimestamp: number }>
    | undefined

  private readonly activeListeners: Map<string, (event: MatrixClientEvent<any>) => void> = new Map()

  private readonly ignoredRooms: string[] = []
  private readonly knownRelayServers: Set<string> = new Set()
  private readonly seenCiphertexts: Set<string> = new Set()
  private readonly inFlightCiphertexts: Set<string> = new Set()
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
  public async findBestRegionAndGetServer(): Promise<
    { server: string; timestamp: number } | undefined
  > {
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

    this.selectedRegion = best.region

    return { server: best.server, timestamp: best.timestamp }
  }

  public async getRelayServer(): Promise<{ server: string; timestamp: number }> {
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
        await this.storage.delete(StorageKey.MATRIX_SELECTED_NODE).catch((e) => logger.log(e))
        const replacementRelayPromise = this.relayServer
        if (replacementRelayPromise === currentPromise) {
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
    // The first caller receives the thrown error directly. Only concurrent callers await this promise.
    discoveryPromise.promise.catch(() => undefined)
    this.relayServer = discoveryPromise

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
          await this.storage.delete(StorageKey.MATRIX_SELECTED_NODE).catch((e) => logger.log(e))
        }
      }

      // Full discovery: probe all servers, pick the fastest
      const server = await this.findBestRegionAndGetServer()

      if (!server) {
        throw new Error('No servers found')
      }

      this.storage
        .set(StorageKey.MATRIX_SELECTED_NODE, server.server)
        .catch((error) => logger.log(error))

      discoveryPromise.resolve({
        server: server.server,
        timestamp: server.timestamp,
        localTimestamp: new Date().getTime()
      })

      return { server: server.server, timestamp: server.timestamp }
    } catch (error) {
      // Always settle the ExposedPromise so concurrent callers don't hang forever
      discoveryPromise.reject(error)
      if (this.relayServer === discoveryPromise) {
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

  public async tryJoinRooms(
    roomId: string,
    retry: number = 1,
    isAuthorized: () => Promise<boolean> = async () => true
  ): Promise<void> {
    const ready = this.client
    const generation = this.startupGeneration
    const isCurrent = () => ready === this.client && generation === this.startupGeneration
    const client = await ready.promise
    const join = async (attempt: number): Promise<void> => {
      if (!isCurrent() || !(await isAuthorized()) || !isCurrent()) {
        return
      }
      try {
        await client.joinRooms(roomId)
      } catch (error) {
        if (attempt <= 10 && (error as { errcode?: string }).errcode === 'M_FORBIDDEN') {
          setTimeout(() => {
            join(attempt + 1).catch((retryError) => logger.error('tryJoinRooms', retryError))
          }, 200)
        } else {
          logger.log(`Failed to join after ${attempt} tries.`, error)
        }
      }
    }
    await join(retry)
  }

  public async start(): Promise<void> {
    const generation = ++this.startupGeneration
    if (this.resetting) {
      await this.resetting
      if (generation !== this.startupGeneration) {
        throw new DOMException('Matrix startup cancelled', 'AbortError')
      }
    }
    logger.log('start', 'starting client')

    logger.log('start', `connecting to server`)

    const relayServer: { server: string; timestamp: number } = await this.getRelayServer()
    if (generation !== this.startupGeneration)
      {throw new DOMException('Matrix startup cancelled', 'AbortError')}

    const client = MatrixClient.create({
      baseUrl: `https://${relayServer.server}`,
      storage: this.storage
    })
    this.startingClient = client

    const ready = this.client
    const isCurrent = () => generation === this.startupGeneration && ready === this.client
    this.initialListener = async (
      event: MatrixClientEvent<MatrixClientEventType.MESSAGE>
    ): Promise<void> => {
      if (!isCurrent()) {
        return
      }
      if (this.initialEvent && this.initialEvent.timestamp && event && event.timestamp) {
        if (this.initialEvent.timestamp < event.timestamp) {
          this.initialEvent = event
        }
      } else {
        this.initialEvent = event
      }
    }
    client.subscribe(MatrixClientEventType.MESSAGE, this.initialListener)

    const handleInvite = async (
      event: MatrixClientEvent<MatrixClientEventType.INVITE>
    ): Promise<void> => {
      if (!isCurrent()) {
        return
      }
      const pairingGeneration = this.pendingPairings.hasPending()
        ? this.pendingPairings.generation
        : undefined
      const ownId = recipientString(await this.getPublicKeyHash(), relayServer.server)
      if (!isCurrent()) {
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
      if ((await isAuthorized()) && isCurrent()) {
        await this.tryJoinRooms(event.content.roomId, 1, isAuthorized)
      }
    }
    client.subscribe(MatrixClientEventType.INVITE, handleInvite)

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

    const secretKey = this.keyPair!.secretKey ?? (this.keyPair as any).privateKey

    const rawSignature = sign(secretKey, loginRawDigest)

    try {
      const id = await this.getPublicKeyHash()
      const password = `ed:${toHex(rawSignature)}:${await this.getPublicKey()}`
      if (!isCurrent()) {
        throw new DOMException('Matrix startup cancelled', 'AbortError')
      }
      await client.start({
        id,
        password,
        deviceId: toHex(this.keyPair!.publicKey)
      })
    } catch (error: any) {
      if (this.startingClient === client) {
        this.startingClient = undefined
      }
      await client.stop().catch((stopError) => logger.error(stopError))
      if (error?.name === 'AbortError' || generation !== this.startupGeneration) {
        throw new DOMException('Matrix startup cancelled', 'AbortError')
      }
      logger.error('start', 'Could not log in, retrying', error)

      if (error.errcode === 'M_USER_DEACTIVATED') {
        await this.generateNewKeyPair()
        if (generation === this.startupGeneration) {
          await this.reset()
        }
        throw new Error('The account is deactivated.')
      }

      await this.reset()
      if (generation !== this.startupGeneration) {
        throw new DOMException('Matrix startup cancelled', 'AbortError')
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

    if (this.startingClient === client) {
      this.startingClient = undefined
    }
    if (generation !== this.startupGeneration) {
      await client.stop()
      throw new DOMException('Matrix startup cancelled', 'AbortError')
    }

    this.loginCounter = 0
    logger.log('start', 'login successful, client is ready')
    this.client.resolve(client)
  }

  public async stop(): Promise<void> {
    ++this.startupGeneration
    this.loginCounter = 0
    const starting = this.startingClient
    this.startingClient = undefined
    try {
      await this.cancelPairingRequests()
    } finally {
      try {
        await starting?.stop()
      } finally {
        logger.log('stop', 'stopping client')

        if (this.client.isResolved()) {
          await (await this.client.promise).stop().catch((error) => logger.error(error))
        }
        await this.reset()
      }
    }
  }

  public async reset(): Promise<void> {
    logger.log('reset', 'resetting connection')

    if (this.resetting) {
      return this.resetting
    }
    this.relayServer = undefined
    this.client = new ExposedPromise()
    this.activeListeners.clear()
    this.initialEvent = undefined
    this.initialListener = undefined
    this.seenCiphertexts.clear()
    this.resetting = this.clearStoredSession().finally(() => {
      this.resetting = undefined
    })

    return this.resetting
  }

  private async clearStoredSession(): Promise<void> {
    await this.storage.delete(StorageKey.MATRIX_PEER_ROOM_IDS).catch((error) => logger.log(error))
    await this.storage.delete(StorageKey.MATRIX_PRESERVED_STATE).catch((error) => logger.log(error))
    await this.storage.delete(StorageKey.MATRIX_SELECTED_NODE).catch((error) => logger.log(error))
  }

  public async listenForEncryptedMessage(
    senderPublicKey: string,
    messageCallback: (message: string) => void
  ): Promise<void> {
    if (this.activeListeners.has(senderPublicKey)) {
      return
    }
    logger.log(
      'listenForEncryptedMessage',
      `start listening for encrypted messages from publicKey ${senderPublicKey}`
    )

    const ready = this.client
    const generation = this.startupGeneration
    const isCurrent = () => ready === this.client && generation === this.startupGeneration
    const sharedKey = await this.createCryptoBoxServer(senderPublicKey, this.keyPair!)
    if (!isCurrent()) {
      return
    }
    const client = await ready.promise
    if (!isCurrent() || this.activeListeners.has(senderPublicKey)) {
      return
    }

    const callbackFunction = async (
      event: MatrixClientEvent<MatrixClientEventType.MESSAGE>
    ): Promise<void> => {
      if (
        isCurrent() &&
        this.isTextMessage(event.content) &&
        (await this.isSender(event, senderPublicKey)) &&
        isCurrent()
      ) {
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
        if (!trustedSenderRelay) {
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
          try {
            const decryptedMessage = await decryptCryptoboxPayload(payload, sharedKey.receive)

            logger.log(
              'listenForEncryptedMessage',
              `received a message from ${senderPublicKey}`,
              decryptedMessage
            )

            // logger.log(
            //   'listenForEncryptedMessage',
            //   'encrypted message received',
            //   decryptedMessage,
            //   await new Serializer().deserialize(decryptedMessage)
            // )
            // console.log('calculated sender ID', await getSenderId(senderPublicKey))
            // TODO: Add check for correct decryption key / sender ID

            const message = (
              decryptedMessage.startsWith('{')
                ? JSON.parse(decryptedMessage)
                : await new Serializer().deserialize(decryptedMessage)
            ) as { senderId?: string }
            if (message.senderId !== (await getSenderId(senderPublicKey)) || !isCurrent()) {
              return
            }
            if (this.seenCiphertexts.has(ciphertext) || this.inFlightCiphertexts.has(ciphertext)) {
              return
            }
            this.inFlightCiphertexts.add(ciphertext)
            try {
              await this.updateRelayServer(event.content.message.sender)
              if (!isCurrent()) {
                return
              }
              await this.updatePeerRoom(event.content.message.sender, event.content.roomId)
              if (!isCurrent()) {
                return
              }
              if (this.seenCiphertexts.size >= 1000) {
                const oldest = this.seenCiphertexts.values().next().value
                if (oldest !== undefined) {
                  this.seenCiphertexts.delete(oldest)
                }
              }
              this.seenCiphertexts.add(ciphertext)
              messageCallback(decryptedMessage)
            } finally {
              this.inFlightCiphertexts.delete(ciphertext)
            }
          } catch (decryptionError) {
            /* NO-OP. We try to decode every message, but some might not be addressed to us. */
          }
        }
      }
    }

    this.activeListeners.set(senderPublicKey, callbackFunction)
    client.subscribe(MatrixClientEventType.MESSAGE, callbackFunction)

    const lastEvent = this.initialEvent
    if (
      lastEvent &&
      lastEvent.timestamp &&
      new Date().getTime() - lastEvent.timestamp < 5 * 60 * 1000
    ) {
      logger.log('listenForEncryptedMessage', 'Handling previous event')
      await callbackFunction(lastEvent)
    } else {
      logger.log('listenForEncryptedMessage', 'No previous event found')
    }

    if (!isCurrent()) {
      return
    }
    const initialListener = this.initialListener
    if (initialListener) {
      client.unsubscribe(MatrixClientEventType.MESSAGE, initialListener)
    }
    this.initialListener = undefined
    this.initialEvent = undefined
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
    logger.log(`updatePeerRoom`, sender, roomId)

    // Sender is in the format "@pubkeyhash:relayserver.tld"
    const split = sender.split(':')
    if (split.length < 2 || !split[0].startsWith('@')) {
      throw new Error('Invalid sender')
    }

    const roomIds = await this.storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)

    const room = roomIds[sender]

    if (room === roomId) {
      logger.debug(`updatePeerRoom`, `rooms are the same, not updating`)
    }

    logger.debug(`updatePeerRoom`, `current room`, room, 'new room', roomId)

    if (room && room[1]) {
      // If we have a room already, let's ignore it. We need to do this, otherwise it will be loaded from the matrix cache.
      logger.log(`updatePeerRoom`, `adding room "${room[1]}" to ignored array`)

      this.ignoredRooms.push(room[1])
    }

    roomIds[sender] = roomId

    await this.storage.set(StorageKey.MATRIX_PEER_ROOM_IDS, roomIds)

    // TODO: We also need to delete the room from the sync state
    // If we need to delete a room, we can assume the local state is not up to date anymore, so we can reset the state
  }

  public async deleteRoomIdFromRooms(roomId: string): Promise<void> {
    const roomIds = await this.storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)
    const newRoomIds = Object.entries(roomIds)
      .filter((entry) => entry[1] !== roomId)
      .reduce(
        (pv, cv) => ({ ...pv, [cv[0]]: cv[1] }),
        {} as {
          [key: string]: string | undefined
        }
      )
    await this.storage.set(StorageKey.MATRIX_PEER_ROOM_IDS, newRoomIds)

    // TODO: We also need to delete the room from the sync state
    // If we need to delete a room, we can assume the local state is not up to date anymore, so we can reset the state

    this.ignoredRooms.push(roomId)
  }

  public async listenForChannelOpening(
    messageCallback: (
      pairingResponse: ExtendedP2PPairingResponse,
      isActive: () => boolean
    ) => void | Promise<void>
  ): Promise<void> {
    logger.debug(`listenForChannelOpening`)
    ;(await this.client.promise).subscribe(MatrixClientEventType.MESSAGE, async (event) => {
      if (this.isTextMessage(event.content) && (await this.isChannelOpenMessage(event.content))) {
        logger.log(
          `listenForChannelOpening`,
          `channel opening received, trying to decrypt`,
          JSON.stringify(event)
        )

        const splits = event.content.message.content.split(':')
        const hexPayload = splits[splits.length - 1]
        if (!hexPayload || hexPayload.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hexPayload)) {
          return
        }
        const payload = Buffer.from(hexPayload, 'hex')

        if (payload.length >= secretbox_NONCEBYTES + secretbox_MACBYTES) {
          try {
            const pairingResponse: P2PPairingResponse = JSON.parse(
              await openCryptobox(payload, this.keyPair!.publicKey, this.keyPair!.secretKey)
            )

            logger.log(
              `listenForChannelOpening`,
              `channel opening received and decrypted`,
              JSON.stringify(pairingResponse)
            )

            if (
              !pairingResponse ||
              typeof pairingResponse.id !== 'string' ||
              typeof pairingResponse.publicKey !== 'string' ||
              !/^[a-f0-9]{64}$/i.test(pairingResponse.publicKey) ||
              typeof pairingResponse.name !== 'string' ||
              typeof pairingResponse.version !== 'string' ||
              !(await this.isSender(event, pairingResponse.publicKey))
            ) {
              return
            }
            const senderId = await getSenderId(pairingResponse.publicKey)
            await this.pendingPairings
              .accept(pairingResponse.id, async (isActive) => {
                await messageCallback(
                  {
                    ...pairingResponse,
                    relayServer: event.content.message.sender.split(':').slice(1).join(':'),
                    senderId
                  },
                  isActive
                )
              })
              .catch((error) =>
                logger.error('listenForChannelOpening', 'pairing acceptance failed', error)
              )
          } catch (decryptionError) {
            /* NO-OP. We try to decode every message, but some might not be addressed to us. */
          }
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
    ;(await this.client.promise).sendTextMessage(roomId, msg).catch(async (error) => {
      if (error.errcode === 'M_FORBIDDEN') {
        // Room doesn't exist
        logger.log(`sendPairingResponse`, `M_FORBIDDEN`, roomId, error)
        await this.deleteRoomIdFromRooms(roomId)
        const newRoomId = await this.getRelevantRoom(recipient)
        logger.log(`sendPairingResponse`, `Old room deleted, new room created`, newRoomId)
        ;(await this.client.promise).sendTextMessage(newRoomId, msg).catch(async (error2) => {
          logger.log(`sendPairingResponse`, `inner error`, newRoomId, error2)
        })
      } else {
        logger.log(`sendPairingResponse`, `unexpected error`, error)
      }
    })
  }

  public isTextMessage(
    content: MatrixClientEventMessageContent<any>
  ): content is MatrixClientEventMessageContent<string> {
    return content.message.type === MatrixMessageType.TEXT
  }

  public async updateRelayServer(sender: string) {
    logger.log(`updateRelayServer`, sender)

    // Sender is in the format "@pubkeyhash:relayserver.tld"
    const split = sender.split(':')
    if (split.length < 2 || !split[0].startsWith('@')) {
      throw new Error('Invalid sender')
    }
    const senderHash = split.shift()
    const relayServer = split.join(':')
    const managers = [
      new PeerManager(this.storage, StorageKey.TRANSPORT_P2P_PEERS_DAPP),
      new PeerManager(this.storage, StorageKey.TRANSPORT_P2P_PEERS_WALLET)
    ]
    for (const manager of managers) {
      const rawPeers = await manager.getPeers()
      const peers = Array.isArray(rawPeers) ? rawPeers : []
      await Promise.all(
        peers.map(async (peer) => {
          const peerHash = `@${await getHexHash(Buffer.from(peer.publicKey, 'hex'))}`
          if (peerHash === senderHash && peer.relayServer !== relayServer) {
            peer.relayServer = relayServer
            await manager.addPeer(peer as ExtendedP2PPairingResponse)
          }
        })
      )
    }
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

  private async generateNewKeyPair() {
    const newSeed = await generateGUID()

    console.warn(`The current user ID has been deactivated. Generating new ID: ${newSeed}`)

    this.storage.set(StorageKey.BEACON_SDK_SECRET_SEED, newSeed)

    this.keyPair = await getKeypairFromSeed(newSeed)
  }

  private async getRelevantRoom(recipient: string): Promise<string> {
    const roomIds = await this.storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)
    let roomId = roomIds[recipient]

    if (!roomId) {
      logger.log(`getRelevantRoom`, `No room found for peer ${recipient}, checking joined ones.`)
      const room = await this.getRelevantJoinedRoom(recipient)
      roomId = room.id
      roomIds[recipient] = room.id
      await this.storage.set(StorageKey.MATRIX_PEER_ROOM_IDS, roomIds)
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
