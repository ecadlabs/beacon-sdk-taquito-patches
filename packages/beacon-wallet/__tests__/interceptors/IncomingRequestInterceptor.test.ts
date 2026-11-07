import { IncomingRequestInterceptor } from '../../src/interceptors/IncomingRequestInterceptor'
import { AppMetadataManager, LocalStorage } from '@ecadlabs/beacon-core'
import {
  BeaconMessageType,
  BeaconRequestMessage,
  NetworkType,
  Origin,
  SigningType
} from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'

const metadata = { senderId: 'dapp', name: 'Dapp' }
const base = { id: 'request', senderId: 'dapp', version: '2' }
const network = { type: NetworkType.MAINNET }
const permission: BeaconRequestMessage = {
  ...base,
  type: BeaconMessageType.PermissionRequest,
  appMetadata: metadata,
  network,
  scopes: []
}
const connectionInfo = { origin: Origin.P2P, id: 'peer' }
function setup() {
  const appMetadataManager = new AppMetadataManager(new LocalStorage())
  const interceptorCallback = vi.fn()
  return { message: permission, connectionInfo, appMetadataManager, interceptorCallback }
}
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

it('persists permission metadata before delivering the request', async () => {
  const config = setup()
  let storedAtDelivery: Promise<unknown> | undefined
  config.interceptorCallback.mockImplementation(() => {
    storedAtDelivery = config.appMetadataManager.getAppMetadata('dapp')
  })
  await IncomingRequestInterceptor.intercept(config)
  await vi.waitFor(() =>
    expect(config.interceptorCallback).toHaveBeenCalledWith(permission, connectionInfo)
  )
  await expect(storedAtDelivery).resolves.toEqual(metadata)
})
const requests: BeaconRequestMessage[] = [
  {
    ...base,
    type: BeaconMessageType.OperationRequest,
    network,
    operationDetails: [],
    sourceAddress: 'tz1'
  },
  {
    ...base,
    type: BeaconMessageType.SignPayloadRequest,
    payload: '0501',
    signingType: SigningType.MICHELINE,
    sourceAddress: 'tz1'
  },
  { ...base, type: BeaconMessageType.BroadcastRequest, network, signedTransaction: 'deadbeef' },
  {
    ...base,
    type: BeaconMessageType.ProofOfEventChallengeRequest,
    payload: 'challenge',
    contractAddress: 'KT1'
  },
  {
    ...base,
    type: BeaconMessageType.SimulatedProofOfEventChallengeRequest,
    payload: 'challenge',
    contractAddress: 'KT1'
  }
]
it.each(requests)('enriches $type with stored metadata', async (message) => {
  const config = setup()
  await config.appMetadataManager.addAppMetadata(metadata)
  await IncomingRequestInterceptor.intercept({ ...config, message })
  await vi.waitFor(() =>
    expect(config.interceptorCallback).toHaveBeenCalledWith(
      { ...message, appMetadata: metadata },
      connectionInfo
    )
  )
})
it.each([BeaconMessageType.PermissionRequest, BeaconMessageType.BlockchainRequest])(
  'forwards V3 %s and uses the envelope sender',
  async (type) => {
    const config = setup()
    const message = {
      ...base,
      version: '3',
      message: {
        ...base,
        type,
        blockchainIdentifier: 'tezos',
        blockchainData: { appMetadata: { name: 'Dapp', senderId: 'spoofed' } }
      }
    }
    await IncomingRequestInterceptor.intercept({ ...config, message })
    await vi.waitFor(() =>
      expect(config.interceptorCallback).toHaveBeenCalledWith(message, connectionInfo)
    )
    if (type === BeaconMessageType.PermissionRequest) {
      expect(await config.appMetadataManager.getAppMetadata('dapp')).toEqual(metadata)
      expect(await config.appMetadataManager.getAppMetadata('spoofed')).toBeUndefined()
    }
  }
)
it('ignores unsupported protocol versions', async () => {
  const config = setup()
  const handlers = IncomingRequestInterceptor as unknown as {
    handleV2Message: (typeof IncomingRequestInterceptor)['handleV2Message']
    handleV3Message: (typeof IncomingRequestInterceptor)['handleV3Message']
  }
  const v2 = vi.spyOn(handlers, 'handleV2Message')
  const v3 = vi.spyOn(handlers, 'handleV3Message')
  await IncomingRequestInterceptor.intercept({
    ...config,
    message: { ...permission, version: '99' }
  })
  expect(v2).not.toHaveBeenCalled()
  expect(v3).not.toHaveBeenCalled()
  expect(config.interceptorCallback).not.toHaveBeenCalled()
})
it('rejects an unknown V2 message in its handler', async () => {
  const config = setup()
  // Deliberately malformed wire input, outside the discriminated protocol union.
  const message = { ...base, type: 'unknown' } as unknown as BeaconRequestMessage
  await expect(
    IncomingRequestInterceptor['handleV2Message']({ ...config, message })
  ).rejects.toThrow('Function not implemented.')
})
// Phase 3.2 RED: public interception must await both protocol handlers.
it.fails.each(['2', '3'])('waits for V%s metadata persistence', async (version) => {
  const config = setup()
  const gate = new ExposedPromise<void>()
  const persist = vi
    .spyOn(config.appMetadataManager, 'addAppMetadata')
    .mockReturnValue(gate.promise)
  const message =
    version === '2'
      ? permission
      : {
          ...base,
          version,
          message: {
            ...base,
            type: BeaconMessageType.PermissionRequest,
            blockchainData: { appMetadata: metadata }
          }
        }
  let complete = false
  const intercepted = IncomingRequestInterceptor.intercept({ ...config, message }).then(() => {
    complete = true
  })
  await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const resolvedEarly = complete
  gate.resolve()
  await intercepted
  await vi.waitFor(() => expect(config.interceptorCallback).toHaveBeenCalledTimes(1))
  expect(resolvedEarly).toBe(false)
})
// Phase 3.2 RED: observe the real handler rejection without leaking it to Vitest.
it.fails.each(['metadata', 'callback'])(
  'propagates %s rejection through intercept',
  async (source) => {
    const config = setup()
    const error = new Error(source)
    if (source === 'metadata')
      vi.spyOn(config.appMetadataManager, 'addAppMetadata').mockRejectedValue(error)
    else
      config.interceptorCallback.mockImplementation(() => {
        throw error
      })
    const original = IncomingRequestInterceptor['handleV2Message'].bind(IncomingRequestInterceptor)
    let handler: Promise<void> | undefined
    vi.spyOn(
      IncomingRequestInterceptor as unknown as { handleV2Message: typeof original },
      'handleV2Message'
    ).mockImplementation((options: Parameters<typeof original>[0]) => {
      handler = original(options)
      void handler.catch(() => {})
      return handler
    })
    const outcome = IncomingRequestInterceptor.intercept(config).then(
      () => undefined,
      (reason: unknown) => reason
    )
    await expect(handler).rejects.toBe(error)
    expect(await outcome).toBe(error)
  }
)

// Phase 3.2 RED: callback work is part of interception, including async rejection.
it.fails.each(['2', '3'])(
  'waits for asynchronous V%s interceptorCallback completion',
  async (version) => {
    const config = setup()
    const gate = new ExposedPromise<void>()
    config.interceptorCallback.mockReturnValue(gate.promise)
    const message =
      version === '2'
        ? permission
        : {
            ...base,
            version,
            message: { ...base, type: BeaconMessageType.BlockchainRequest, blockchainData: {} }
          }
    let completed = false
    const outcome = IncomingRequestInterceptor.intercept({ ...config, message }).then(() => {
      completed = true
    })
    await vi.waitFor(() => expect(config.interceptorCallback).toHaveBeenCalledTimes(1))
    const resolvedEarly = completed
    gate.resolve()
    await outcome
    expect(resolvedEarly).toBe(false)
  }
)
// Phase 3.2 RED: observe callback rejection separately, without changing its rejected state.
it.fails('propagates a rejected async interceptorCallback promise', async () => {
  const config = setup()
  const error = new Error('async callback')
  const rejection = Promise.reject(error)
  void rejection.catch(() => {})
  config.interceptorCallback.mockReturnValue(rejection)
  const outcome = IncomingRequestInterceptor.intercept(config).then(
    () => undefined,
    (reason: unknown) => reason
  )
  await vi.waitFor(() => expect(config.interceptorCallback).toHaveBeenCalledTimes(1))
  expect(await outcome).toBe(error)
})

it('rejects requests whose sender has no stored app metadata', async () => {
  const config = setup()
  await expect(
    IncomingRequestInterceptor['handleV2Message']({ ...config, message: requests[0] })
  ).rejects.toThrow('AppMetadata not found')
  expect(config.interceptorCallback).not.toHaveBeenCalled()
})
it('rejects an unknown V3 message in its handler', async () => {
  const config = setup()
  const message = { ...base, version: '3', message: { ...base, type: 'unknown' } }
  // Malformed wire input is intentionally outside the protocol union.
  await expect(
    IncomingRequestInterceptor['handleV3Message']({
      ...config,
      message: message as unknown as Parameters<
        (typeof IncomingRequestInterceptor)['handleV3Message']
      >[0]['message']
    })
  ).rejects.toThrow('Function not implemented.')
})

it('normalizes legacy beaconId metadata before persisting and delivering it', async () => {
  const config = setup()
  // Legacy V1 wire metadata predates the required senderId field.
  const message = {
    ...permission,
    appMetadata: { name: 'Legacy', beaconId: 'legacy-id' }
  } as unknown as BeaconRequestMessage
  await IncomingRequestInterceptor['handleV2Message']({ ...config, message })
  expect(await config.appMetadataManager.getAppMetadata('legacy-id')).toEqual({
    name: 'Legacy',
    senderId: 'legacy-id'
  })
  expect(config.interceptorCallback).toHaveBeenCalledWith(
    { ...permission, appMetadata: { name: 'Legacy', senderId: 'legacy-id' } },
    connectionInfo
  )
})
