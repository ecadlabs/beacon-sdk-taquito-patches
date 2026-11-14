import { vi } from 'vitest'
import { reportDiagnostic } from '@ecadlabs/beacon-core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MobilePairing } from '../../src/ui/alert/components/pairing-alert/components/mobile-pairing'
import { AlertState } from '../../src/ui/common'
import { MergedWallet } from '../../src/utils/wallets'

vi.mock('@ecadlabs/beacon-core', async (importActual) => ({
  ...(await importActual<typeof import('@ecadlabs/beacon-core')>()),
  reportDiagnostic: vi.fn()
}))

const wallet: MergedWallet = {
  id: 'kukai',
  key: 'kukai_ios',
  name: 'Kukai',
  image: '',
  descriptions: ['Mobile'],
  types: ['ios'],
  links: ['https://wallet.example']
}

const callbacks = () => ({
  handleDeepLinking: vi.fn(async (_wallet: MergedWallet): Promise<void> => {}),
  handleUpdateState: vi.fn((_state: AlertState): void => {}),
  handleUpdateQRCode: vi.fn((_code: string): void => {}),
  handleDisplayQRExtra: vi.fn((_display: boolean): void => {}),
  onClose: vi.fn()
})

describe('Mobile pairing actions', () => {
  it('opens the selected wallet and offers the Kukai download on iOS', () => {
    const userAgent = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('iPhone')
    const actions = callbacks()
    try {
      render(
        <MobilePairing
          {...actions}
          wallet={wallet}
          wcPayload={Promise.resolve('wc-code')}
          p2pPayload={Promise.resolve('p2p-code')}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Use App' }))
      expect(actions.handleDeepLinking).toHaveBeenCalledWith(wallet)
      expect(screen.getByRole('link', { name: 'Get Kukai Mobile >' }).getAttribute('href')).toBe(
        'https://ios.kukai.app'
      )
    } finally {
      userAgent.mockRestore()
    }
  })

  it.each([
    { standards: ['wallet_connect'], expected: 'wc-code' },
    { standards: ['beacon'], expected: 'p2p-code' }
  ] satisfies {
    standards: NonNullable<MergedWallet['supportedInteractionStandards']>
    expected: string
  }[])('shows the selected protocol payload for $standards', async ({ standards, expected }) => {
    const actions = callbacks()
    const { container } = render(
      <MobilePairing
        {...actions}
        wallet={{ ...wallet, supportedInteractionStandards: standards }}
        wcPayload={Promise.resolve('wc-code')}
        p2pPayload={Promise.resolve('p2p-code')}
      />
    )
    const qrButton = container.querySelector('button#qr-code-icon')
    if (!qrButton) throw new Error('QR action was not rendered')
    fireEvent.click(qrButton)
    await waitFor(() => expect(actions.handleUpdateQRCode).toHaveBeenCalledWith(expected))
    expect(actions.handleUpdateState).toHaveBeenCalledWith(AlertState.QR)
    expect(actions.handleDisplayQRExtra).toHaveBeenCalledWith(true)
    expect(actions.onClose).not.toHaveBeenCalled()
  })

  it('closes without displaying a QR code when the selected payload is empty', async () => {
    const actions = callbacks()
    const { container } = render(
      <MobilePairing
        {...actions}
        wallet={wallet}
        wcPayload={Promise.resolve('unused')}
        p2pPayload={Promise.resolve('')}
      />
    )
    const qrButton = container.querySelector('button#qr-code-icon')
    if (!qrButton) throw new Error('QR action was not rendered')
    fireEvent.click(qrButton)
    await waitFor(() => expect(actions.onClose).toHaveBeenCalledTimes(1))
    expect(actions.handleUpdateQRCode).not.toHaveBeenCalled()
    expect(actions.handleUpdateState).not.toHaveBeenCalled()
    expect(actions.handleDisplayQRExtra).not.toHaveBeenCalled()
  })
})

it('consumes a rejected Use App callback and reports its original cause', async () => {
  const actions = callbacks()
  const error = new Error('launch failed')
  actions.handleDeepLinking.mockRejectedValue(error)
  render(
    <MobilePairing
      {...actions}
      wallet={wallet}
      wcPayload={Promise.resolve('unused')}
      p2pPayload={Promise.resolve('code')}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Use App' }))
  await waitFor(() =>
    expect(reportDiagnostic).toHaveBeenCalledWith({
      level: 'error',
      service: 'MobilePairing',
      method: 'openApp',
      args: [error]
    })
  )
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

it.each(['payload', 'close'] as const)(
  'consumes a rejected QR %s without displaying a QR code',
  async (failure) => {
    const actions = callbacks()
    const error = new Error('QR action failed')
    const pairing = deferred<string>()
    actions.onClose.mockRejectedValue(error)
    const { container } = render(
      <MobilePairing
        {...actions}
        wallet={wallet}
        wcPayload={Promise.resolve('unused')}
        p2pPayload={pairing.promise}
      />
    )
    const qrButton = container.querySelector('button#qr-code-icon')
    if (!qrButton) throw new Error('QR action was not rendered')
    fireEvent.click(qrButton)
    await act(async () => {
      if (failure === 'payload') pairing.reject(error)
      else pairing.resolve('')
    })
    expect(reportDiagnostic).toHaveBeenCalledTimes(1)
    expect(reportDiagnostic).toHaveBeenCalledWith({
      level: 'error',
      service: 'MobilePairing',
      method: 'showQRCode',
      args: [error]
    })
    expect(actions.handleUpdateQRCode).not.toHaveBeenCalled()
    expect(actions.handleUpdateState).not.toHaveBeenCalled()
  }
)

it.each(['wallet change', 'Use App', 'unmount'] as const)(
  'ignores a pending QR request after %s',
  async (nextAction) => {
    const actions = callbacks()
    const pairing = deferred<string>()
    const props = {
      ...actions,
      wallet,
      wcPayload: Promise.resolve('unused'),
      p2pPayload: pairing.promise
    }
    const view = render(<MobilePairing {...props} />)
    const qrButton = view.container.querySelector('button#qr-code-icon')
    if (!qrButton) throw new Error('QR action was not rendered')
    fireEvent.click(qrButton)
    if (nextAction === 'wallet change')
      view.rerender(<MobilePairing {...props} wallet={{ ...wallet, id: 'new-wallet' }} />)
    else if (nextAction === 'Use App')
      fireEvent.click(screen.getByRole('button', { name: 'Use App' }))
    else view.unmount()
    await act(async () => {
      pairing.resolve('obsolete-code')
    })
    expect(actions.handleUpdateQRCode).not.toHaveBeenCalled()
    expect(actions.handleUpdateState).not.toHaveBeenCalled()
    expect(actions.handleDisplayQRExtra).not.toHaveBeenCalled()
    expect(actions.onClose).not.toHaveBeenCalled()
  }
)
