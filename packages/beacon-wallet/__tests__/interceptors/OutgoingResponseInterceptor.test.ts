import { OutgoingResponseInterceptor } from '../../src/interceptors/OutgoingResponseInterceptor'
import {
  AppMetadataManager,
  PermissionManager,
  LocalStorage,
  getAccountIdentifier
} from '@ecadlabs/beacon-core'
import {
  BeaconMessageType,
  BeaconResponseInputMessage,
  BeaconErrorType,
  NetworkType,
  SigningType
} from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'

const metadata = { senderId: 'dapp', name: 'Dapp' }
const ownAppMetadata = { senderId: 'wallet', name: 'Wallet' }
const network = { type: NetworkType.MAINNET }
const publicKey = 'edpkuSLWfVU1Vq7Jg9FucPyKmma6otcMHac9zG4oU1KMHSTBpJuGQ2'
const address = 'tz1TGu6TN5GSez2ndXXeDX6LgUDvLzPLqgYV'
const permission: BeaconResponseInputMessage = {
  id: 'one',
  type: BeaconMessageType.PermissionResponse,
  publicKey,
  network,
  scopes: [],
  walletType: 'implicit'
}
function setup(message: BeaconResponseInputMessage = permission) {
  const storage = new LocalStorage()
  return {
    senderId: 'wallet',
    request: {
      id: 'one',
      senderId: 'dapp',
      version: '2',
      type: BeaconMessageType.PermissionRequest as const,
      appMetadata: metadata,
      network,
      scopes: []
    },
    message,
    ownAppMetadata,
    appMetadataManager: new AppMetadataManager(storage),
    permissionManager: new PermissionManager(storage),
    interceptorCallback: vi.fn()
  }
}
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())
const responses: BeaconResponseInputMessage[] = [
  { id: 'one', type: BeaconMessageType.Acknowledge },
  { id: 'one', type: BeaconMessageType.Error, errorType: BeaconErrorType.ABORTED_ERROR },
  { id: 'one', type: BeaconMessageType.OperationResponse, transactionHash: 'opHash' },
  {
    id: 'one',
    type: BeaconMessageType.SignPayloadResponse,
    signature: 'sig',
    signingType: SigningType.RAW
  },
  { id: 'one', type: BeaconMessageType.BroadcastResponse, transactionHash: 'opHash' },
  {
    id: 'one',
    type: BeaconMessageType.ProofOfEventChallengeResponse,
    payloadHash: 'hash',
    isAccepted: true
  },
  {
    id: 'one',
    type: BeaconMessageType.SimulatedProofOfEventChallengeResponse,
    operationsList: 'W10=',
    errorMessage: ''
  }
]
it.each(responses)('adds envelope fields to $type', async (message) => {
  const config = setup(message)
  const outcome = OutgoingResponseInterceptor.intercept(config)
  expect(config.interceptorCallback).toHaveBeenCalledTimes(1)
  await outcome
  expect(config.interceptorCallback).toHaveBeenCalledWith({
    ...message,
    senderId: 'wallet',
    version: '2'
  })
})
it('derives and persists the permission address and metadata', async () => {
  const config = setup()
  await config.appMetadataManager.addAppMetadata(metadata)
  await OutgoingResponseInterceptor.intercept(config)
  await vi.waitFor(async () =>
    expect(await config.permissionManager.getPermissions()).toHaveLength(1)
  )
  const [stored] = await config.permissionManager.getPermissions()
  expect(stored).toEqual({
    accountIdentifier: await getAccountIdentifier(address, network),
    senderId: 'dapp',
    appMetadata: metadata,
    website: '',
    address,
    publicKey,
    network,
    scopes: [],
    connectedAt: expect.any(Number)
  })
  expect(config.interceptorCallback).toHaveBeenCalledWith({
    ...permission,
    senderId: 'wallet',
    version: '2',
    appMetadata: ownAppMetadata
  })
})
it('rejects missing metadata before persisting a permission', async () => {
  const config = setup()
  await expect(OutgoingResponseInterceptor.intercept(config)).rejects.toThrow(
    'AppMetadata not found'
  )
  expect(await config.permissionManager.getPermissions()).toEqual([])
  expect(config.interceptorCallback).not.toHaveBeenCalled()
})
it.each([undefined, [{ kind: 'temporary', id: 'rpc.error' }], [{ invalid: true }]])(
  'filters invalid RPC error data: %j',
  async (errorData) => {
    const config = setup({
      id: 'one',
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.TRANSACTION_INVALID_ERROR,
      errorData
    })
    await OutgoingResponseInterceptor.intercept(config)
    const response = config.interceptorCallback.mock.calls[0][0]
    expect(response.errorData).toEqual(
      errorData?.[0] && 'kind' in errorData[0] ? errorData : undefined
    )
  }
)
it('waits for permissionManager.addPermission before resolving', async () => {
  const config = setup()
  await config.appMetadataManager.addAppMetadata(metadata)
  const gate = new ExposedPromise<void>()
  const persist = vi.spyOn(config.permissionManager, 'addPermission').mockReturnValue(gate.promise)
  let complete = false
  const outcome = OutgoingResponseInterceptor.intercept(config).then(() => {
    complete = true
  })
  await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  const resolvedEarly = complete
  const sentEarly = config.interceptorCallback.mock.calls.length
  gate.resolve()
  await outcome
  expect(resolvedEarly).toBe(false)
  expect(sentEarly).toBe(0)
})
it('waits for the V3 interceptor callback', async () => {
  const config = setup()
  const gate = new ExposedPromise<void>()
  config.interceptorCallback.mockReturnValue(gate.promise)
  const request = { ...config.request, version: '3' }
  // The runtime accepts V3 wrappers, although its input annotation lists only V2 responses.
  const message = {
    id: 'one',
    senderId: 'wallet',
    version: '3',
    message: {
      type: BeaconMessageType.BlockchainResponse,
      blockchainIdentifier: 'tezos',
      blockchainData: {}
    }
  } as unknown as BeaconResponseInputMessage
  let completed = false
  const outcome = OutgoingResponseInterceptor.intercept({ ...config, request, message }).then(
    () => {
      completed = true
    }
  )
  await vi.waitFor(() => expect(config.interceptorCallback).toHaveBeenCalledTimes(1))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const resolvedEarly = completed
  gate.resolve()
  await outcome
  expect(resolvedEarly).toBe(false)
})

it.each([...responses, permission])(
  'waits for the V2 $type callback to finish',
  async (message) => {
    const config = setup(message)
    await config.appMetadataManager.addAppMetadata(metadata)
    const gate = new ExposedPromise<void>()
    config.interceptorCallback.mockReturnValue(gate.promise)
    let complete = false
    const outcome = OutgoingResponseInterceptor.intercept(config).then(() => {
      complete = true
    })
    try {
      await vi.waitFor(() => expect(config.interceptorCallback).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(complete).toBe(false)
    } finally {
      gate.resolve()
      await outcome
    }
  }
)
it.each([...responses, permission])(
  'propagates the V2 $type callback rejection',
  async (message) => {
    const config = setup(message)
    await config.appMetadataManager.addAppMetadata(metadata)
    const error = new Error('send failed')
    const rejected = Promise.reject(error)
    void rejected.catch(() => {})
    config.interceptorCallback.mockReturnValue(rejected)
    const outcome = OutgoingResponseInterceptor.intercept(config).then(
      () => undefined,
      (reason: unknown) => reason
    )
    await vi.waitFor(() => expect(config.interceptorCallback).toHaveBeenCalledTimes(1))
    expect(await outcome).toBe(error)
  }
)
it('rejects unknown V2 response types', async () => {
  const message = { id: 'unknown', type: 'unknown' } as unknown as BeaconResponseInputMessage
  const config = setup(message)
  await expect(OutgoingResponseInterceptor.intercept(config)).rejects.toThrow(
    'Function not implemented.'
  )
  expect(config.interceptorCallback).not.toHaveBeenCalled()
})

const contractAddress = 'KT1TxqZ8QtKvLu3V3JH7Gx58n7Co8pgtpQU5'
const missingCredentials = 'Address or PublicKey must be defined'
const invalidAddress = 'Invalid address'
const invalidAbstractedAddress = 'Invalid abstracted account address'
type CredentialCase = {
  name: string
  fields: Pick<
    Extract<BeaconResponseInputMessage, { type: BeaconMessageType.PermissionResponse }>,
    'address' | 'publicKey' | 'walletType'
  >
  expected: { kind: 'accepted'; address: string } | { kind: 'rejected'; error: string }
}
const credentialCases = [
  {
    name: 'missing credentials before metadata',
    fields: { address: undefined, publicKey: undefined, walletType: undefined },
    expected: { kind: 'rejected', error: missingCredentials }
  },
  {
    name: 'empty public key without an address',
    fields: { address: undefined, publicKey: '', walletType: 'implicit' },
    expected: { kind: 'rejected', error: missingCredentials }
  },
  {
    name: 'key-only implicit default without adding a wire address',
    fields: { address: undefined, publicKey, walletType: undefined },
    expected: { kind: 'accepted', address }
  },
  {
    name: 'empty address without a public key',
    fields: { address: '', publicKey: undefined, walletType: 'abstracted_account' },
    expected: { kind: 'rejected', error: missingCredentials }
  },
  {
    name: 'both credentials empty',
    fields: { address: '', publicKey: '', walletType: 'implicit' },
    expected: { kind: 'rejected', error: missingCredentials }
  },
  {
    name: 'empty address takes precedence over a valid key',
    fields: { address: '', publicKey, walletType: 'implicit' },
    expected: { kind: 'rejected', error: invalidAddress }
  },
  {
    name: 'invalid address before abstracted-account validation',
    fields: { address: 'invalid', publicKey: undefined, walletType: 'abstracted_account' },
    expected: { kind: 'rejected', error: invalidAddress }
  },
  {
    name: 'invalid address takes precedence over a valid key',
    fields: { address: 'invalid', publicKey, walletType: 'implicit' },
    expected: { kind: 'rejected', error: invalidAddress }
  },
  {
    name: 'explicit implicit address without a public key',
    fields: { address, publicKey: undefined, walletType: 'implicit' },
    expected: { kind: 'accepted', address }
  },
  {
    name: 'implicit address cannot represent an abstracted account',
    fields: { address, publicKey: '', walletType: 'abstracted_account' },
    expected: { kind: 'rejected', error: invalidAbstractedAddress }
  },
  {
    name: 'valid explicit address does not derive an invalid key',
    fields: { address, publicKey: 'invalid-key', walletType: 'implicit' },
    expected: { kind: 'accepted', address }
  },
  {
    name: 'contract address for an abstracted account',
    fields: { address: contractAddress, publicKey: undefined, walletType: 'abstracted_account' },
    expected: { kind: 'accepted', address: contractAddress }
  },
  {
    name: 'contract address with the implicit default',
    fields: { address: contractAddress, publicKey: '', walletType: undefined },
    expected: { kind: 'accepted', address: contractAddress }
  },
  {
    name: 'explicit contract address does not derive an invalid key',
    fields: { address: contractAddress, publicKey: 'invalid-key', walletType: 'abstracted_account' },
    expected: { kind: 'accepted', address: contractAddress }
  },
  {
    name: 'derived implicit address cannot represent an abstracted account',
    fields: { address: undefined, publicKey, walletType: 'abstracted_account' },
    expected: { kind: 'rejected', error: invalidAbstractedAddress }
  }
] satisfies CredentialCase[]
it.each(credentialCases)('preserves permission credentials: $name', async ({ fields, expected }) => {
  const config = setup()
  if (expected.kind === 'accepted') {
    await config.appMetadataManager.addAppMetadata(metadata)
  }
  // Exercise JavaScript callers too: some compatibility and rejection cases violate the input union.
  const outcome: Promise<void> = Reflect.apply(
    OutgoingResponseInterceptor.intercept,
    OutgoingResponseInterceptor,
    [{ ...config, message: { ...permission, ...fields } }]
  )
  if (expected.kind === 'accepted') {
    await outcome
    expect(await config.permissionManager.getPermissions()).toEqual([
      expect.objectContaining({ address: expected.address })
    ])
    expect((await config.permissionManager.getPermissions())[0]?.publicKey).toBe(fields.publicKey)
    expect(config.interceptorCallback).toHaveBeenCalledWith({
      senderId: 'wallet',
      version: '2',
      appMetadata: ownAppMetadata,
      ...permission,
      ...fields,
      walletType: fields.walletType ?? 'implicit'
    })
  } else {
    await expect(outcome).rejects.toThrow(expected.error)
    expect(await config.permissionManager.getPermissions()).toEqual([])
    expect(config.interceptorCallback).not.toHaveBeenCalled()
  }
})

it('propagates permission persistence failure without sending the response', async () => {
  const config = setup()
  await config.appMetadataManager.addAppMetadata(metadata)
  const failure = new Error('permission storage failed')
  vi.spyOn(config.permissionManager, 'addPermission').mockRejectedValue(failure)
  await expect(OutgoingResponseInterceptor.intercept(config)).rejects.toBe(failure)
  expect(config.interceptorCallback).not.toHaveBeenCalled()
})
