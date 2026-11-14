import { reportDiagnostic } from '@ecadlabs/beacon-core'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { QR } from '../../src/components/qr/index'
import { getTzip10Link } from '../../src/utils/get-tzip10-link'
import { getQrData } from '../../src/utils/qr'

vi.mock('@ecadlabs/beacon-core', async (importActual) => ({
  ...(await importActual<typeof import('@ecadlabs/beacon-core')>()),
  reportDiagnostic: vi.fn()
}))

// --- Mocks --- //
vi.mock('../../src/utils/get-tzip10-link', () => ({
  getTzip10Link: vi.fn()
}))

vi.mock('../../src/utils/qr', () => ({
  getQrData: vi.fn()
}))

describe('QR Component', () => {
  const dummySvg = '<svg><text>QR CODE</text></svg>'
  const walletName = 'TestWallet'
  const code = 'sample-code'
  const tzip10Payload = 'dummy-tzip10-link'

  beforeEach(() => {
    // When getTzip10Link is called, return a dummy payload.
    ;(getTzip10Link as Mock).mockReturnValue(tzip10Payload)
    // When getQrData is called, return our dummy SVG.
    ;(getQrData as Mock).mockReturnValue(dummySvg)

    // Set up a mock for navigator.clipboard.writeText.
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  test('renders desktop view correctly', async () => {
    render(<QR isWalletConnect={false} isMobile={false} walletName={walletName} code={code} />)

    // For desktop, a heading "Or scan to connect" should be rendered.
    expect(screen.getByText(/Or scan to connect/i)).toBeInTheDocument()
    // The wallet instruction text should be rendered.
    expect(
      screen.getByText(new RegExp(`Open ${walletName} Wallet on your mobile phone and scan.`, 'i'))
    ).toBeInTheDocument()

    // Since onClickLearnMore was not provided, no "Learn more" element should be rendered.
    expect(screen.queryByText(/Learn more/i)).not.toBeInTheDocument()

    // Wait for the QR SVG to be set by useEffect.
    await waitFor(() => {
      const svgWrapper = document.querySelector('.qr-svg-wrapper')
      expect(svgWrapper?.innerHTML).toBe(dummySvg)
    })

    // Check that getQrData was called with desktop dimensions (160x160).
    expect(getQrData).toHaveBeenCalledWith(tzip10Payload, 160, 160)
  })

  test('renders mobile view with "Learn more" when onClickLearnMore is provided', async () => {
    const onClickLearnMore = vi.fn()
    render(
      <QR
        isWalletConnect={true}
        isMobile={true}
        walletName={walletName}
        code={code}
        onClickLearnMore={onClickLearnMore}
      />
    )

    // Mobile view should instruct scanning with a WalletConnect-compatible wallet.
    expect(
      screen.getByText(/Scan QR code with a WalletConnect-compatible wallet\./i)
    ).toBeInTheDocument()

    // Wait for the QR SVG to be set.
    await waitFor(() => {
      const svgWrapper = document.querySelector('.qr-svg-wrapper')
      expect(svgWrapper?.innerHTML).toBe(dummySvg)
    })

    // Check that getQrData was called with mobile dimensions (300x300).
    expect(getQrData).toHaveBeenCalledWith(tzip10Payload, 300, 300)
  })

  test('handles copy to clipboard and shows "Copied!" message', async () => {
    vi.useFakeTimers()
    const onClickQrCode = vi.fn()
    render(
      <QR
        isWalletConnect={false}
        isMobile={true}
        walletName={walletName}
        code={code}
        onClickQrCode={onClickQrCode}
      />
    )

    // Locate the clickable QR area.
    const qrRightDiv = document.querySelector('.qr-right')
    expect(qrRightDiv).toBeInTheDocument()

    // Click the QR area.
    if (qrRightDiv) {
      fireEvent.click(qrRightDiv)
    }

    // Verify that onClickQrCode was called.
    expect(onClickQrCode).toHaveBeenCalledTimes(1)
    // Verify that navigator.clipboard.writeText was called with the correct code.
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    // After clicking, the UI should change to show the "Copied!" message.
    expect(screen.getByText(/Copied!/i)).toBeInTheDocument()

    // Wrap timer advancement in act to flush pending state updates.
    act(() => {
      vi.advanceTimersByTime(3000)
    })

    // After the timeout, the UI should show "Copy to clipboard" again.
    expect(screen.getByText(/Copy to clipboard/i)).toBeInTheDocument()
  })

  test.each(['callback throw', 'callback reject', 'clipboard reject', 'code change', 'unmount'])(
    'owns clipboard completion and diagnostics across %s', async (outcome) => {
      vi.useFakeTimers()
      const failure = new Error('copy action failed')
      let finishCopy: (() => void) | undefined
      const write = vi.fn(() => outcome === 'clipboard reject'
        ? Promise.reject(failure)
        : new Promise<void>((resolve) => { finishCopy = resolve }))
      navigator.clipboard.writeText = write
      let remove: (() => void) | undefined
      const onClickQrCode = vi.fn(() => {
        if (outcome === 'unmount') remove?.()
        if (outcome === 'callback throw') throw failure
        return outcome === 'callback reject' ? Promise.reject(failure) : undefined
      })
      const view = render(<QR isWalletConnect={false} isMobile walletName={walletName}
        code={code} onClickQrCode={onClickQrCode} />)
      remove = () => view.unmount()
      const copy = view.container.querySelector('.qr-right')
      if (!copy) throw new Error('Copy action missing')
      fireEvent.click(copy)
      expect(onClickQrCode).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledExactlyOnceWith(code)
      if (outcome === 'code change') view.rerender(
        <QR isWalletConnect={false} isMobile walletName={walletName} code="new-code" />)
      await act(async () => { finishCopy?.() })
      const failed = outcome.includes('callback') || outcome === 'clipboard reject'
      expect(reportDiagnostic).toHaveBeenCalledTimes(failed ? 1 : 0)
      if (failed) {
        expect(JSON.stringify(vi.mocked(reportDiagnostic).mock.calls)).not.toContain(code)
      }
      if (outcome === 'code change' || outcome === 'unmount') {
        expect(view.queryByText('Copied!')).not.toBeInTheDocument()
        expect(vi.getTimerCount()).toBe(0)
      } else if (outcome !== 'clipboard reject') {
        expect(screen.getByText('Copied!')).toBeInTheDocument()
        expect(vi.getTimerCount()).toBe(1)
        view.unmount()
        expect(vi.getTimerCount()).toBe(0)
      }
    }
  )

  test('uses getTzip10Link and getQrData correctly based on isMobile prop', async () => {
    // Render with isMobile true.
    const { rerender } = render(
      <QR isWalletConnect={false} isMobile={true} walletName={walletName} code={code} />
    )

    await waitFor(() => {
      expect(getQrData).toHaveBeenCalledWith(tzip10Payload, 300, 300)
    })

    // Rerender with isMobile false.
    rerender(<QR isWalletConnect={false} isMobile={false} walletName={walletName} code={code} />)

    await waitFor(() => {
      expect(getQrData).toHaveBeenCalledWith(tzip10Payload, 160, 160)
    })
  })
})
