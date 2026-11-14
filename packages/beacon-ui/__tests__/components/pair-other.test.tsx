import { reportDiagnostic } from '@ecadlabs/beacon-core'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { PairOther } from '../../src/components/pair-other'
import { PairOtherProps } from '../../src/ui/common'

vi.mock('@ecadlabs/beacon-core', async (importActual) => ({
  ...(await importActual<typeof import('@ecadlabs/beacon-core')>()),
  reportDiagnostic: vi.fn()
}))

const deferred = () => {
  let resolve: (value: string) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<string>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

// Mock the QR component so that we can inspect its rendered output.
vi.mock('../../src/components/qr', () => {
  // The mock receives props and renders a dummy element with the passed code and isWalletConnect info.
  return {
    QR: (props: any) => (
      <div data-testid="qr-component">
        QR: {props.code} {props.isWalletConnect ? 'walletconnect' : 'p2p'}
      </div>
    )
  }
})

describe('PairOther Component', () => {
  const defaultProps: PairOtherProps = {
    walletList: [],
    p2pPayload: Promise.resolve('p2p-code'),
    wcPayload: Promise.resolve('wc-code'),
    onClickLearnMore: vi.fn()
  }

  test('replaces resolved QR and ignores obsolete availability when payloads change', async () => {
    const oldWC = deferred()
    const nextP2P = deferred()
    const nextWC = deferred()
    const view = render(<PairOther {...defaultProps} wcPayload={oldWC.promise} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Beacon' }))
    expect(await screen.findByTestId('qr-component')).toHaveTextContent('p2p-code')
    view.rerender(<PairOther {...defaultProps} p2pPayload={nextP2P.promise} wcPayload={nextWC.promise} />)
    expect(screen.queryByTestId('qr-component')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Beacon' })).not.toBeInTheDocument()
    await act(async () => oldWC.resolve('old-wc'))
    expect(screen.queryByRole('button', { name: 'WalletConnect' })).not.toBeInTheDocument()
    await act(async () => { nextP2P.resolve('new-p2p'); nextWC.resolve('') })
    fireEvent.click(await screen.findByRole('button', { name: 'Beacon' }))
    expect(await screen.findByTestId('qr-component')).toHaveTextContent('new-p2p')
    expect(reportDiagnostic).not.toHaveBeenCalled()
  })

  test.each(['late success', 'late rejection', 'current rejection'])(
    'owns a thenable QR click across %s', async (outcome) => {
      const pending = deferred()
      let reads = 0
      const wcPayload: PromiseLike<string> = {
        then(onfulfilled, onrejected) {
          return (reads++ === 0 ? Promise.resolve('available-wc') : pending.promise)
            .then(onfulfilled, onrejected)
        }
      }
      render(<PairOther {...defaultProps} wcPayload={wcPayload} />)
      fireEvent.click(await screen.findByRole('button', { name: 'WalletConnect' }))
      if (outcome !== 'current rejection') {
        fireEvent.click(await screen.findByRole('button', { name: 'Beacon' }))
        expect(await screen.findByTestId('qr-component')).toHaveTextContent('p2p-code')
      }
      const failure = new Error('QR request failed')
      await act(async () => {
        if (outcome === 'late success') pending.resolve('old-wc')
        else pending.reject(failure)
      })
      if (outcome === 'current rejection') {
        expect(screen.queryByTestId('qr-component')).not.toBeInTheDocument()
        expect(reportDiagnostic).toHaveBeenCalledExactlyOnceWith({
          level: 'error', service: 'PairOther', method: 'selectQR', args: [failure]
        })
      } else {
        expect(screen.getByTestId('qr-component')).toHaveTextContent('p2p-code')
        expect(reportDiagnostic).not.toHaveBeenCalled()
      }
    }
  )

  test('renders selection view with both buttons when payloads are provided', async () => {
    render(<PairOther {...defaultProps} />)

    // Wait for the prompt message to appear.
    expect(await screen.findByText(/Select QR Type/i)).toBeInTheDocument()

    // Wait for both buttons to be rendered.
    const beaconButton = await screen.findByRole('button', { name: /Beacon/i })
    const walletConnectButton = await screen.findByRole('button', { name: /WalletConnect/i })
    expect(beaconButton).toBeInTheDocument()
    expect(walletConnectButton).toBeInTheDocument()
  })

  test('shows Beacon option when WalletConnect payload does not resolve', async () => {
    const props: PairOtherProps = {
      walletList: [],
      p2pPayload: Promise.resolve('p2p-code'),
      wcPayload: new Promise<string>(() => {}),
      onClickLearnMore: vi.fn()
    }

    render(<PairOther {...props} />)

    const beaconButton = await screen.findByRole('button', { name: /Beacon/i })

    expect(beaconButton).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /WalletConnect/i })).not.toBeInTheDocument()
  })

  test('clicking the Beacon button shows the QR component with p2p payload', async () => {
    render(<PairOther {...defaultProps} />)

    // Wait for the Beacon button to appear.
    const beaconButton = await screen.findByRole('button', { name: /Beacon/i })
    fireEvent.click(beaconButton)

    // After clicking, wait for the QR component to render.
    const qrComponent = await screen.findByTestId('qr-component')
    expect(qrComponent).toBeInTheDocument()
    expect(qrComponent).toHaveTextContent('p2p-code')
    expect(qrComponent).toHaveTextContent('p2p')
  })

  test('clicking the WalletConnect button shows the QR component with walletconnect payload', async () => {
    render(<PairOther {...defaultProps} />)

    // Wait for the WalletConnect button to appear.
    const wcButton = await screen.findByRole('button', { name: /WalletConnect/i })
    fireEvent.click(wcButton)

    // After clicking, wait for the QR component to render.
    const qrComponent = await screen.findByTestId('qr-component')
    expect(qrComponent).toBeInTheDocument()
    expect(qrComponent).toHaveTextContent('wc-code')
    expect(qrComponent).toHaveTextContent('walletconnect')
  })

  test('renders selection view without action buttons when no payload is provided', async () => {
    const props: PairOtherProps = {
      walletList: [],
      p2pPayload: Promise.resolve(''),
      wcPayload: Promise.resolve(''),
      onClickLearnMore: vi.fn()
    }

    render(<PairOther {...props} />)

    // Wait for the prompt to appear.
    expect(await screen.findByText(/Select QR Type/i)).toBeInTheDocument()

    // The buttons should not be rendered if the payloads are empty.
    expect(screen.queryByRole('button', { name: /Beacon/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /WalletConnect/i })).not.toBeInTheDocument()
  })
})
