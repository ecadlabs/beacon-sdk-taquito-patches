import { describe, it, expect, vi, beforeEach, afterEach, expectTypeOf } from 'vitest'
import {
  AppMetadataManager,
  LocalStorage,
  PermissionManager
} from '@ecadlabs/beacon-core'
import {
  BeaconErrorType,
  BeaconMessageType,
  NetworkType,
  PermissionScope,
  SigningType,
  type PermissionRequestOutput,
  type OperationRequestOutput,
  type SignPayloadRequestOutput,
  type BroadcastRequestOutput,
  type ProofOfEventChallengeRequestOutput,
  type SimulatedProofOfEventChallengeRequestOutput,
  type PermissionResponseInput,
  type OperationResponseInput,
  type SignPayloadResponseInput,
  type BroadcastResponseInput,
  type ProofOfEventChallengeResponseInput,
  type SimulatedProofOfEventChallengeResponseInput,
  type ErrorResponseInput,
  type ResponseInputForRequest
} from '@ecadlabs/beacon-types'
import {
  WalletClient,
  buildPermissionResponse,
  buildOperationResponse,
  buildSignPayloadResponse,
  buildBroadcastResponse,
  buildErrorResponse,
  type ResponseInputForRequest as WalletResponseInputForRequest
} from '../src'
import { OutgoingResponseInterceptor } from '../src/interceptors/OutgoingResponseInterceptor'

const metadata = { senderId: 'dapp-sender', name: 'DApp Example' }
const ownAppMetadata = { senderId: 'wallet-sender', name: 'Wallet Example' }
const network = { type: NetworkType.MAINNET }
const validEdpk = 'edpktpzo8UZieYaJZgCHP6M6hKHPdWBSNqxvmEt6dwWRgxDh1EAFw9'
const validAddress = 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb'
const validContractAddress = 'KT1TxqZ8QtKvLu3V3JH7Gx58n7Co8pgtpQU5'

describe('ResponseBuildersAndTypes (Issue #143)', () => {
  describe('Part 1: Discriminated union for PermissionResponseInput and OutgoingResponseInterceptor runtime behavior', () => {
    describe('Type-level assignability (expectTypeOf)', () => {
      it('accepts implicit account branch with walletType omitted', () => {
        const input = {
          id: 'test-id-1',
          type: BeaconMessageType.PermissionResponse as const,
          publicKey: validEdpk,
          network,
          scopes: [PermissionScope.SIGN]
        }
        expectTypeOf(input).toMatchTypeOf<PermissionResponseInput>()
      })

      it('accepts implicit account branch with walletType implicit and publicKey (with optional address)', () => {
        const inputWithAddress = {
          id: 'test-id-2',
          type: BeaconMessageType.PermissionResponse as const,
          walletType: 'implicit' as const,
          publicKey: validEdpk,
          address: validAddress,
          network,
          scopes: [PermissionScope.SIGN]
        }
        expectTypeOf(inputWithAddress).toMatchTypeOf<PermissionResponseInput>()

        const inputWithoutAddress = {
          id: 'test-id-3',
          type: BeaconMessageType.PermissionResponse as const,
          walletType: 'implicit' as const,
          publicKey: validEdpk,
          network,
          scopes: [PermissionScope.SIGN]
        }
        expectTypeOf(inputWithoutAddress).toMatchTypeOf<PermissionResponseInput>()
      })

      it('accepts abstracted account branch with walletType abstracted_account and address (no publicKey)', () => {
        const inputAbstracted = {
          id: 'test-id-4',
          type: BeaconMessageType.PermissionResponse as const,
          walletType: 'abstracted_account' as const,
          address: validContractAddress,
          network,
          scopes: [PermissionScope.SIGN]
        }
        expectTypeOf(inputAbstracted).toMatchTypeOf<PermissionResponseInput>()
      })

      it('rejects invalid shapes at compile time', () => {
        // Missing both publicKey and address
        // @ts-expect-error missing both publicKey and address on PermissionResponseInput
        const missingBoth: PermissionResponseInput = {
          id: 'invalid-1',
          type: BeaconMessageType.PermissionResponse,
          network,
          scopes: [PermissionScope.SIGN]
        }
        expect(missingBoth).toBeDefined()

        // Missing publicKey when walletType is implicit or omitted
        // @ts-expect-error missing publicKey when walletType is implicit
        const missingPublicKeyImplicit: PermissionResponseInput = {
          id: 'invalid-2',
          type: BeaconMessageType.PermissionResponse,
          walletType: 'implicit',
          address: validAddress,
          network,
          scopes: [PermissionScope.SIGN]
        }
        expect(missingPublicKeyImplicit).toBeDefined()

        // Missing address on abstracted_account
        // @ts-expect-error missing address or providing publicKey on abstracted_account
        const missingAddressAbstracted: PermissionResponseInput = {
          id: 'invalid-3',
          type: BeaconMessageType.PermissionResponse,
          walletType: 'abstracted_account',
          publicKey: validEdpk,
          network,
          scopes: [PermissionScope.SIGN]
        }
        expect(missingAddressAbstracted).toBeDefined()

        // Providing publicKey on abstracted_account
        // @ts-expect-error publicKey must not be a string on abstracted_account
        const publicKeyOnAbstracted: PermissionResponseInput = {
          id: 'invalid-4',
          type: BeaconMessageType.PermissionResponse,
          walletType: 'abstracted_account',
          address: validContractAddress,
          publicKey: validEdpk,
          network,
          scopes: [PermissionScope.SIGN]
        }
        expect(publicKeyOnAbstracted).toBeDefined()
      })
    })

    describe('Runtime behavior (OutgoingResponseInterceptor.intercept)', () => {
      let storage: LocalStorage
      let appMetadataManager: AppMetadataManager
      let permissionManager: PermissionManager
      let interceptorCallback: ReturnType<typeof vi.fn>

      beforeEach(async () => {
        localStorage.clear()
        storage = new LocalStorage()
        appMetadataManager = new AppMetadataManager(storage)
        permissionManager = new PermissionManager(storage)
        interceptorCallback = vi.fn()
        await appMetadataManager.addAppMetadata(metadata)
      })

      afterEach(() => {
        vi.restoreAllMocks()
      })

      const baseRequest = {
        id: 'req-perm-1',
        senderId: metadata.senderId,
        version: '2',
        type: BeaconMessageType.PermissionRequest as const,
        appMetadata: metadata,
        network,
        scopes: [PermissionScope.SIGN]
      }

      it('defaults walletType to implicit when omitted, derives tz1 address for permissions, preserves wire response, and records permission', async () => {
        const message: PermissionResponseInput = {
          id: 'req-perm-1',
          type: BeaconMessageType.PermissionResponse,
          publicKey: validEdpk,
          network,
          scopes: [PermissionScope.SIGN]
        }

        await OutgoingResponseInterceptor.intercept({
          senderId: ownAppMetadata.senderId,
          request: baseRequest,
          message,
          ownAppMetadata,
          permissionManager,
          appMetadataManager,
          interceptorCallback
        })

        expect(interceptorCallback).toHaveBeenCalledTimes(1)
        const emittedResponse = interceptorCallback.mock.calls[0]?.[0]
        expect(emittedResponse).toMatchObject({
          id: 'req-perm-1',
          type: BeaconMessageType.PermissionResponse,
          walletType: 'implicit',
          publicKey: validEdpk,
          network,
          scopes: [PermissionScope.SIGN],
          senderId: ownAppMetadata.senderId,
          version: '2'
        })
        expect(emittedResponse.address).toBeUndefined()

        const storedPermissions = await permissionManager.getPermissions()
        expect(storedPermissions).toHaveLength(1)
        expect(storedPermissions[0]).toMatchObject({
          senderId: metadata.senderId,
          address: 'tz1Mg6uXUhJzuCh4dH2mdBdYBuaiVZCCZsak',
          publicKey: validEdpk,
          network,
          scopes: [PermissionScope.SIGN]
        })
      })

      it('preserves walletType implicit and preserves address on emitted response when explicitly passed', async () => {
        const message: PermissionResponseInput = {
          id: 'req-perm-1',
          type: BeaconMessageType.PermissionResponse,
          walletType: 'implicit',
          publicKey: validEdpk,
          address: validAddress,
          network,
          scopes: [PermissionScope.SIGN]
        }

        await OutgoingResponseInterceptor.intercept({
          senderId: ownAppMetadata.senderId,
          request: baseRequest,
          message,
          ownAppMetadata,
          permissionManager,
          appMetadataManager,
          interceptorCallback
        })

        expect(interceptorCallback).toHaveBeenCalledTimes(1)
        const emittedResponse = interceptorCallback.mock.calls[0]?.[0]
        expect(emittedResponse.walletType).toBe('implicit')
        expect(emittedResponse.address).toBe(validAddress)
      })

      it('preserves walletType implicit when explicitly passed without address', async () => {
        const message: PermissionResponseInput = {
          id: 'req-perm-1',
          type: BeaconMessageType.PermissionResponse,
          walletType: 'implicit',
          publicKey: validEdpk,
          network,
          scopes: [PermissionScope.SIGN]
        }

        await OutgoingResponseInterceptor.intercept({
          senderId: ownAppMetadata.senderId,
          request: baseRequest,
          message,
          ownAppMetadata,
          permissionManager,
          appMetadataManager,
          interceptorCallback
        })

        expect(interceptorCallback).toHaveBeenCalledTimes(1)
        const emittedResponse = interceptorCallback.mock.calls[0]?.[0]
        expect(emittedResponse.walletType).toBe('implicit')
        expect(emittedResponse.address).toBeUndefined()
      })

      it('preserves walletType abstracted_account and preserves address without requiring publicKey', async () => {
        const message: PermissionResponseInput = {
          id: 'req-perm-1',
          type: BeaconMessageType.PermissionResponse,
          walletType: 'abstracted_account',
          address: validContractAddress,
          network,
          scopes: [PermissionScope.SIGN]
        }

        await OutgoingResponseInterceptor.intercept({
          senderId: ownAppMetadata.senderId,
          request: baseRequest,
          message,
          ownAppMetadata,
          permissionManager,
          appMetadataManager,
          interceptorCallback
        })

        expect(interceptorCallback).toHaveBeenCalledTimes(1)
        const emittedResponse = interceptorCallback.mock.calls[0]?.[0]
        expect(emittedResponse.walletType).toBe('abstracted_account')
        expect(emittedResponse.address).toBe(validContractAddress)
        expect(emittedResponse.publicKey).toBeUndefined()

        const storedPermissions = await permissionManager.getPermissions()
        expect(storedPermissions).toHaveLength(1)
        expect(storedPermissions[0]?.address).toBe(validContractAddress)
        expect(storedPermissions[0]?.publicKey).toBeUndefined()
      })
    })
  })

  describe('Part 2: ResponseInputForRequest<T> type mapping', () => {
    it('maps PermissionRequestOutput to PermissionResponseInput | ErrorResponseInput', () => {
      expectTypeOf<ResponseInputForRequest<PermissionRequestOutput>>().toEqualTypeOf<
        PermissionResponseInput | ErrorResponseInput
      >()
    })

    it('maps OperationRequestOutput to OperationResponseInput | ErrorResponseInput', () => {
      expectTypeOf<ResponseInputForRequest<OperationRequestOutput>>().toEqualTypeOf<
        OperationResponseInput | ErrorResponseInput
      >()
    })

    it('maps SignPayloadRequestOutput to SignPayloadResponseInput | ErrorResponseInput', () => {
      expectTypeOf<ResponseInputForRequest<SignPayloadRequestOutput>>().toEqualTypeOf<
        SignPayloadResponseInput | ErrorResponseInput
      >()
    })

    it('maps BroadcastRequestOutput to BroadcastResponseInput | ErrorResponseInput', () => {
      expectTypeOf<ResponseInputForRequest<BroadcastRequestOutput>>().toEqualTypeOf<
        BroadcastResponseInput | ErrorResponseInput
      >()
    })

    it('maps ProofOfEventChallengeRequestOutput to ProofOfEventChallengeResponseInput | ErrorResponseInput', () => {
      expectTypeOf<ResponseInputForRequest<ProofOfEventChallengeRequestOutput>>().toEqualTypeOf<
        ProofOfEventChallengeResponseInput | ErrorResponseInput
      >()
    })

    it('maps SimulatedProofOfEventChallengeRequestOutput to SimulatedProofOfEventChallengeResponseInput | ErrorResponseInput', () => {
      expectTypeOf<ResponseInputForRequest<SimulatedProofOfEventChallengeRequestOutput>>().toEqualTypeOf<
        SimulatedProofOfEventChallengeResponseInput | ErrorResponseInput
      >()
    })

    it('distributes over request unions: PermissionRequestOutput | OperationRequestOutput', () => {
      expectTypeOf<
        ResponseInputForRequest<PermissionRequestOutput | OperationRequestOutput>
      >().toEqualTypeOf<
        PermissionResponseInput | OperationResponseInput | ErrorResponseInput
      >()
    })

    it('re-exports ResponseInputForRequest from @ecadlabs/beacon-wallet', () => {
      expectTypeOf<WalletResponseInputForRequest<PermissionRequestOutput>>().toEqualTypeOf<
        ResponseInputForRequest<PermissionRequestOutput>
      >()
    })
  })

  describe('Part 3: Typed response builders exported from @ecadlabs/beacon-wallet', () => {
    const permRequest: PermissionRequestOutput = {
      id: 'req-perm-builder',
      senderId: 'dapp-sender',
      version: '2',
      type: BeaconMessageType.PermissionRequest,
      appMetadata: metadata,
      network,
      scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST]
    }

    const opRequest: OperationRequestOutput = {
      id: 'req-op-builder',
      senderId: 'dapp-sender',
      sourceAddress: validAddress,
      version: '2',
      type: BeaconMessageType.OperationRequest,
      appMetadata: metadata,
      network,
      operationDetails: []
    }

    const signRequest: SignPayloadRequestOutput = {
      id: 'req-sign-builder',
      senderId: 'dapp-sender',
      sourceAddress: validAddress,
      version: '2',
      type: BeaconMessageType.SignPayloadRequest,
      appMetadata: metadata,
      signingType: SigningType.RAW,
      payload: '05010000001148656c6c6f20776f726c64'
    }

    const broadcastRequest: BroadcastRequestOutput = {
      id: 'req-broadcast-builder',
      senderId: 'dapp-sender',
      version: '2',
      type: BeaconMessageType.BroadcastRequest,
      appMetadata: metadata,
      network,
      signedTransaction: '0501...'
    }

    describe('buildPermissionResponse', () => {
      it('builds implicit account response with minimal options (publicKey only)', () => {
        const response = buildPermissionResponse(permRequest, { publicKey: validEdpk })
        expect(response).toEqual({
          id: permRequest.id,
          type: BeaconMessageType.PermissionResponse,
          network: permRequest.network,
          scopes: permRequest.scopes,
          walletType: 'implicit',
          publicKey: validEdpk
        })
      })

      it('enforces property hygiene: omitted optional fields are not present on minimal response', () => {
        const response = buildPermissionResponse(permRequest, { publicKey: validEdpk })
        expect(response).not.toHaveProperty('threshold')
        expect(response).not.toHaveProperty('notification')
        expect(response).not.toHaveProperty('verificationType')
        expect(response).not.toHaveProperty('address')
      })

      it('builds implicit account response preserving overrides for scopes, network, address, threshold, notification, verificationType', () => {
        const customNetwork = { type: NetworkType.GHOSTNET }
        const customScopes = [PermissionScope.SIGN]
        const threshold = { amount: '100', timeframe: 'daily' }
        const notification = {
          version: 1,
          apiUrl: 'https://push.example.com',
          token: 'push-token-123'
        }

        const response = buildPermissionResponse(permRequest, {
          walletType: 'implicit',
          publicKey: validEdpk,
          address: validAddress,
          network: customNetwork,
          scopes: customScopes,
          threshold,
          notification,
          verificationType: 'proof_of_event'
        })

        expect(response).toEqual({
          id: permRequest.id,
          type: BeaconMessageType.PermissionResponse,
          walletType: 'implicit',
          publicKey: validEdpk,
          address: validAddress,
          network: customNetwork,
          scopes: customScopes,
          threshold,
          notification,
          verificationType: 'proof_of_event'
        })
      })

      it('builds abstracted account response with walletType abstracted_account and address', () => {
        const response = buildPermissionResponse(permRequest, {
          walletType: 'abstracted_account',
          address: validContractAddress
        })

        expect(response).toEqual({
          id: permRequest.id,
          type: BeaconMessageType.PermissionResponse,
          walletType: 'abstracted_account',
          address: validContractAddress,
          network: permRequest.network,
          scopes: permRequest.scopes
        })
      })

      it('enforces compile-time type safety on buildPermissionResponse options', () => {
        // Missing publicKey when not abstracted_account
        // @ts-expect-error rejects address without publicKey when walletType is implicit or omitted
        const invalidImplicit = buildPermissionResponse(permRequest, { address: validAddress })
        expect(invalidImplicit).toBeDefined()

        // Missing address on abstracted_account
        // @ts-expect-error rejects abstracted_account without address
        const invalidAbstracted = buildPermissionResponse(permRequest, {
          walletType: 'abstracted_account',
          publicKey: validEdpk
        })
        expect(invalidAbstracted).toBeDefined()
      })
    })

    describe('buildOperationResponse', () => {
      it('builds operation response from request and transactionHash', () => {
        const response = buildOperationResponse(opRequest, 'op-hash-123')
        expect(response).toEqual({
          id: opRequest.id,
          type: BeaconMessageType.OperationResponse,
          transactionHash: 'op-hash-123'
        })
      })
    })

    describe('buildSignPayloadResponse', () => {
      it('defaults signingType to request.signingType when omitted', () => {
        const response = buildSignPayloadResponse(signRequest, 'sig-abc')
        expect(response).toEqual({
          id: signRequest.id,
          type: BeaconMessageType.SignPayloadResponse,
          signingType: SigningType.RAW,
          signature: 'sig-abc'
        })
      })

      it('allows overriding signingType when explicitly passed', () => {
        const response = buildSignPayloadResponse(signRequest, 'sig-def', SigningType.MICHELINE)
        expect(response).toEqual({
          id: signRequest.id,
          type: BeaconMessageType.SignPayloadResponse,
          signingType: SigningType.MICHELINE,
          signature: 'sig-def'
        })
      })
    })

    describe('buildBroadcastResponse', () => {
      it('builds broadcast response from request and transactionHash', () => {
        const response = buildBroadcastResponse(broadcastRequest, 'tx-hash-789')
        expect(response).toEqual({
          id: broadcastRequest.id,
          type: BeaconMessageType.BroadcastResponse,
          transactionHash: 'tx-hash-789'
        })
      })
    })

    describe('buildErrorResponse', () => {
      it('accepts BeaconRequestOutputMessage object and returns ErrorResponseInput', () => {
        const response = buildErrorResponse(permRequest, BeaconErrorType.NOT_GRANTED_ERROR)
        expect(response).toEqual({
          id: permRequest.id,
          type: BeaconMessageType.Error,
          errorType: BeaconErrorType.NOT_GRANTED_ERROR
        })
        expect(response).not.toHaveProperty('errorData')
      })

      it('accepts { id: string } object', () => {
        const response = buildErrorResponse({ id: 'custom-id-99' }, BeaconErrorType.ABORTED_ERROR)
        expect(response).toEqual({
          id: 'custom-id-99',
          type: BeaconMessageType.Error,
          errorType: BeaconErrorType.ABORTED_ERROR
        })
      })

      it('accepts string ID directly', () => {
        const response = buildErrorResponse('string-id-100', BeaconErrorType.PARAMETERS_INVALID_ERROR)
        expect(response).toEqual({
          id: 'string-id-100',
          type: BeaconMessageType.Error,
          errorType: BeaconErrorType.PARAMETERS_INVALID_ERROR
        })
      })

      it('includes errorData only when defined', () => {
        const rpcError = [{ kind: 'temporary', id: 'proto.error' }]
        const withData = buildErrorResponse(
          opRequest,
          BeaconErrorType.TRANSACTION_INVALID_ERROR,
          rpcError
        )
        expect(withData).toEqual({
          id: opRequest.id,
          type: BeaconMessageType.Error,
          errorType: BeaconErrorType.TRANSACTION_INVALID_ERROR,
          errorData: rpcError
        })

        const withUndefined = buildErrorResponse(
          opRequest,
          BeaconErrorType.TRANSACTION_INVALID_ERROR,
          undefined
        )
        expect(withUndefined).not.toHaveProperty('errorData')
      })
    })

    describe('WalletClient.respond signatures and runtime behavior', () => {
      it('supports correlated call with generic, correlated call with request argument, and uncorrelated call', async () => {
        const storage = new LocalStorage()
        const client = new WalletClient({ name: 'TestWallet', storage })

        expectTypeOf(client.respond).toBeCallableWith(
          buildOperationResponse(opRequest, 'hash')
        )

        expectTypeOf(client.respond<PermissionRequestOutput>).toBeCallableWith(
          buildPermissionResponse(permRequest, { publicKey: validEdpk })
        )

        expectTypeOf(client.respond).toBeCallableWith(
          buildPermissionResponse(permRequest, { publicKey: validEdpk }),
          permRequest
        )
      })

      it('enforces compile-time request/response correlation', () => {
        if (false) {
          const storage = new LocalStorage()
          const client = new WalletClient({ name: 'TestWallet', storage })

          // @ts-expect-error Generic correlation reject: Operation response is not valid for PermissionRequestOutput
          client.respond<PermissionRequestOutput>(buildOperationResponse(opRequest, 'hash'))

          // @ts-expect-error Correlated 2-arg reject: Operation response is not valid for PermissionRequestOutput request
          client.respond(buildOperationResponse(opRequest, 'hash'), permRequest)
        }
      })

      it('succeeds at runtime when response.id matches request.id and request is pending', async () => {
        const storage = new LocalStorage()
        const client = new WalletClient({ name: 'TestWallet', storage })
        const interceptSpy = vi
          .spyOn(OutgoingResponseInterceptor, 'intercept')
          .mockResolvedValue(undefined)
        vi.spyOn(client as any, 'getOwnAppMetadata').mockResolvedValue(ownAppMetadata)

        const pendingReq = {
          id: 'correlated-req-1',
          senderId: 'dapp-sender',
          version: '2',
          type: BeaconMessageType.OperationRequest,
          network,
          operationDetails: [],
          sourceAddress: validAddress
        }
        ;(client as any).pendingRequests = [[pendingReq, {}]]

        const response = {
          id: 'correlated-req-1',
          type: BeaconMessageType.OperationResponse as const,
          transactionHash: 'hash-corr-1'
        }

        await expect(client.respond(response, pendingReq as any)).resolves.toBeUndefined()
        expect(interceptSpy).toHaveBeenCalledTimes(1)
        expect((client as any).pendingRequests).toHaveLength(0)
      })

      it('rejects at runtime when response.id does not match request.id', async () => {
        const storage = new LocalStorage()
        const client = new WalletClient({ name: 'TestWallet', storage })

        const pendingReq = {
          id: 'correlated-req-2',
          senderId: 'dapp-sender',
          version: '2',
          type: BeaconMessageType.OperationRequest,
          network,
          operationDetails: [],
          sourceAddress: validAddress
        }
        ;(client as any).pendingRequests = [[pendingReq, {}]]

        const mismatchedResponse = {
          id: 'different-id',
          type: BeaconMessageType.OperationResponse as const,
          transactionHash: 'hash-corr-2'
        }

        await expect(client.respond(mismatchedResponse, pendingReq as any)).rejects.toThrow(
          'Response ID does not match request ID'
        )
      })

      it('delegates to respond via convenience methods on WalletClient', async () => {
        const storage = new LocalStorage()
        const client = new WalletClient({ name: 'TestWallet', storage })
        const respondSpy = vi.spyOn(client, 'respond').mockResolvedValue(undefined)

        await client.respondPermission(permRequest, { publicKey: validEdpk })
        expect(respondSpy).toHaveBeenLastCalledWith(
          buildPermissionResponse(permRequest, { publicKey: validEdpk })
        )

        await client.respondOperation(opRequest, 'op-hash-convenience')
        expect(respondSpy).toHaveBeenLastCalledWith(
          buildOperationResponse(opRequest, 'op-hash-convenience')
        )

        await client.respondSignPayload(signRequest, 'sig-convenience', SigningType.MICHELINE)
        expect(respondSpy).toHaveBeenLastCalledWith(
          buildSignPayloadResponse(signRequest, 'sig-convenience', SigningType.MICHELINE)
        )

        await client.respondBroadcast(broadcastRequest, 'tx-convenience')
        expect(respondSpy).toHaveBeenLastCalledWith(
          buildBroadcastResponse(broadcastRequest, 'tx-convenience')
        )

        await client.respondError(permRequest, BeaconErrorType.ABORTED_ERROR)
        expect(respondSpy).toHaveBeenLastCalledWith(
          buildErrorResponse(permRequest, BeaconErrorType.ABORTED_ERROR)
        )
      })
    })
  })
})
