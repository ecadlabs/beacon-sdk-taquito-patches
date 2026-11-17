import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { openAlert, openToast } from '@ecadlabs/beacon-ui'
import {
  BeaconErrorType,
  BeaconMessageType,
  builtInLocales,
  configureBeaconI18n,
  getBeaconDirection,
  getBeaconMessages,
  NetworkType,
  Origin,
  resetBeaconI18n,
  TransportType
} from '@ecadlabs/beacon-types'
import { BeaconEvent, defaultEventCallbacks } from '../src/events'
import { DAppClient } from '../src/dapp-client/DAppClient'

vi.mock('@ecadlabs/beacon-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecadlabs/beacon-ui')>()
  return {
    ...actual,
    closeAlert: vi.fn(),
    closeToast: vi.fn(),
    isMobile: vi.fn().mockReturnValue(false),
    isMobileOS: vi.fn().mockReturnValue(false),
    openAlert: vi.fn(),
    openToast: vi.fn()
  }
})

describe('BeaconEvent i18n and DAppClientOptions locale configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetBeaconI18n()
  })

  afterEach(() => {
    resetBeaconI18n()
  })

  it('localizes toast and alert copy in defaultEventCallbacks across sent, error, and late-response branches', async () => {
    configureBeaconI18n({ locale: 'fr' })
    const fr = builtInLocales.fr

    await defaultEventCallbacks[BeaconEvent.PERMISSION_REQUEST_SENT]({
      requestId: 'req-1',
      requestType: BeaconMessageType.PermissionRequest,
      transport: TransportType.P2P,
      dispatchStage: 'transport',
      sentAt: 1,
      walletInfo: { name: 'Kukai' },
      extraInfo: {}
    })
    expect(openToast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: fr.dapp.requestSent,
        actions: expect.arrayContaining([
          expect.objectContaining({ text: fr.dapp.noAnswerFromWallet }),
          expect.objectContaining({
            text: fr.dapp.walletNotReceivingRequest,
            actionText: fr.dapp.resetConnection
          })
        ])
      })
    )

    await defaultEventCallbacks[BeaconEvent.PERMISSION_REQUEST_ERROR]({
      requestId: 'req-2',
      receivedAt: 2,
      walletInfo: { name: 'Kukai' },
      errorResponse: {
        id: 'req-2',
        version: '2',
        senderId: 'peer-1',
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.ABORTED_ERROR,
        errorOrigin: 'local'
      }
    })
    expect(openToast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: fr.dapp.walletRequestCancelled,
        actions: expect.arrayContaining([
          expect.objectContaining({
            text: fr.errors[BeaconErrorType.ABORTED_ERROR].title,
            isBold: true
          })
        ])
      })
    )

    await defaultEventCallbacks[BeaconEvent.LATE_RESPONSE_RECEIVED]({
      kind: 'success',
      requestId: 'req-late-bcast',
      requestType: BeaconMessageType.BroadcastRequest,
      timedOutAt: 3,
      receivedAt: 4,
      transport: TransportType.P2P,
      walletInfo: { name: 'Kukai' },
      connectionContext: { origin: Origin.P2P, id: 'peer-1' },
      transactionHash: 'ooLateBcast123',
      response: {
        id: 'req-late-bcast',
        version: '2',
        senderId: 'peer-1',
        type: BeaconMessageType.BroadcastResponse,
        transactionHash: 'ooLateBcast123'
      }
    })
    expect(openToast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: fr.dapp.lateBroadcastToast,
        actions: expect.arrayContaining([
          expect.objectContaining({ actionText: fr.dapp.copyToClipboard })
        ])
      })
    )
  })

  it('configures locale, direction, and custom translations from DAppClientOptions and cleans up on destroy without leaking', async () => {
    configureBeaconI18n({ locale: 'fr' })
    expect(getBeaconMessages().meta.locale).toBe('fr')
    expect(getBeaconDirection()).toBe('ltr')

    const client = new DAppClient({
      name: 'Test dApp',
      locale: 'es',
      direction: 'rtl',
      translations: {
        dapp: {
          preparingRequest: 'Preparando personalizado...'
        }
      }
    })

    try {
      expect(getBeaconDirection()).toBe('rtl')
      expect(getBeaconMessages().meta.locale).toBe('es')

      await defaultEventCallbacks[BeaconEvent.SHOW_PREPARE]({})
      expect(openToast).toHaveBeenLastCalledWith(
        expect.objectContaining({
          body: 'Preparando personalizado...'
        })
      )

      await defaultEventCallbacks[BeaconEvent.PAIR_INIT]({
        p2pPeerInfo: Promise.resolve('p2p'),
        postmessagePeerInfo: Promise.resolve('post'),
        walletConnectPeerInfo: Promise.resolve({ ok: true, uri: 'wc:test' }),
        networkType: NetworkType.MAINNET,
        analytics: { track: vi.fn() }
      })
      expect(openAlert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title: builtInLocales.es.dapp.choosePreferredWallet
        })
      )

      await expect(client.requestSignPayload({ payload: '' })).rejects.toMatchObject({
        description: builtInLocales.es.dapp.payloadRequired
      })
    } finally {
      await client.destroy()
    }

    // Destroying the overridden client restores the preconfigured global French state
    expect(getBeaconMessages().meta.locale).toBe('fr')
    expect(getBeaconDirection()).toBe('ltr')

    // Sequential client with no i18n options after reset uses English default
    resetBeaconI18n()
    const arClient = new DAppClient({
      name: 'Arabic dApp',
      locale: 'ar'
    })
    expect(getBeaconMessages().meta.locale).toBe('ar')
    expect(getBeaconDirection()).toBe('rtl')
    await arClient.destroy()

    const defaultClient = new DAppClient({
      name: 'Default dApp'
    })
    try {
      expect(getBeaconMessages().meta.locale).toBe('en')
      expect(getBeaconDirection()).toBe('ltr')
    } finally {
      await defaultClient.destroy()
    }
  })
})
