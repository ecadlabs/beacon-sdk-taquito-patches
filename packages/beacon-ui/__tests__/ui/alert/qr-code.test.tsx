import { act, render, screen, waitFor } from '@testing-library/react'
import QRCode from '../../../src/ui/alert/components/pairing-alert/components/qr-code'
import { MergedWallet } from '../../../src/utils/wallets'
import { AlertState } from '../../../src/ui/common'

jest.mock('../../../src/components/qr', () => (props: { isWalletConnect: boolean; code: string }) => (
  <div data-testid="qr" data-walletconnect={props.isWalletConnect ? 'true' : 'false'}>
    {props.code}
  </div>
))

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })

  return { promise, resolve, reject }
}

const wallet = (
  supportedInteractionStandards: MergedWallet['supportedInteractionStandards']
): MergedWallet => ({
  id: 'wallet',
  key: 'wallet',
  name: 'Wallet',
  image: 'wallet.png',
  descriptions: ['Mobile App'],
  links: ['', '', '', ''],
  types: ['ios'],
  supportedInteractionStandards
})

describe('Pairing alert QRCode', () => {
  it('does not substitute the Matrix pairing QR for a WalletConnect wallet', async () => {
    const p2pPairing = deferred<string>()
    const handleIsLoading = jest.fn()

    render(
      <QRCode
        wallet={wallet(['wallet_connect'])}
        isWCWorking
        isMobile={false}
        defaultPairing={p2pPairing.promise}
        handleUpdateState={jest.fn<void, [AlertState]>()}
        handleIsLoading={handleIsLoading}
      />
    )

    await act(async () => {
      p2pPairing.resolve('p2p-code')
    })

    expect(screen.getByText('Preparing Wallet QR code...')).toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(handleIsLoading).not.toHaveBeenCalled()
  })

  it('uses the Matrix pairing QR as the default for Beacon-only wallets', async () => {
    const handleIsLoading = jest.fn()

    render(
      <QRCode
        wallet={wallet(['beacon'])}
        isWCWorking={false}
        isMobile={false}
        defaultPairing={Promise.resolve('p2p-code')}
        handleUpdateState={jest.fn<void, [AlertState]>()}
        handleIsLoading={handleIsLoading}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('qr')).toHaveTextContent('p2p-code')
    })
    expect(screen.getByTestId('qr')).toHaveAttribute('data-walletconnect', 'false')
    expect(handleIsLoading).toHaveBeenCalledWith(false)
  })
})
