import type { Mock } from 'vitest'
// src/components/toast/index.test.tsx
import { render, screen, fireEvent, act } from '@testing-library/react'
import Toast from '../../src/components/toast/index'

// --- Mock external dependencies ---
// Use the real useDrag hook so drag state and reset behavior are tested end-to-end with Toast.
// Mock isMobileOS so that by default it returns false (non-mobile).
vi.mock('../../src/utils/platform', () => ({
  isMobileOS: vi.fn(() => false)
}))

// Import the isMobileOS so we can override it in tests.
import { isMobileOS } from '../../src/utils/platform'

describe('Toast Component', () => {
  beforeEach(() => {
    // Use fake timers for any setTimeout behavior.
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  test('renders toast with show class when open is true and hide class when false', () => {
    const { rerender, container } = render(
      <Toast label="Test Toast" open={true} onClickClose={vi.fn()} />
    )
    expect(container.firstChild).toHaveClass('toast-wrapper-show')

    rerender(<Toast label="Test Toast" open={false} onClickClose={vi.fn()} />)
    expect(container.firstChild).toHaveClass('toast-wrapper-hide')
  })

  test('calls onClickClose when the close icon is clicked', () => {
    const onClickClose = vi.fn()
    render(<Toast label="Test Toast" open={true} onClickClose={onClickClose} />)

    // The close icon is rendered inside a div with the "button-icon" class.
    const closeIconDiv = document.querySelector('.button-icon')
    expect(closeIconDiv).toBeInTheDocument()

    if (closeIconDiv) {
      fireEvent.click(closeIconDiv)
    }
    expect(onClickClose).toHaveBeenCalled()
  })

  test('renders plain label if no wallet placeholder is present', () => {
    const label = 'Simple Toast Label'
    render(<Toast label={label} open={true} onClickClose={vi.fn()} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  test('renders wallet info when label includes {{wallet}} and walletInfo is provided', () => {
    const label = 'Payment received from {{wallet}}!'
    const walletInfo = {
      icon: 'wallet-icon.png',
      name: 'TestWallet'
    }
    const { container } = render(
      <Toast label={label} open={true} onClickClose={vi.fn()} walletInfo={walletInfo} />
    )
    // Verify that the wallet icon is rendered (using its alt text)
    const walletIcon = screen.getByAltText(`${walletInfo.name} icon`)
    expect(walletIcon).toBeInTheDocument()

    // Verify that the wallet name is rendered as a heading.
    expect(screen.getByRole('heading', { name: walletInfo.name })).toBeInTheDocument()

    // Because the text "Payment received from" is split across multiple elements,
    // we check that the overall text content contains it.
    expect(container.textContent).toContain('Payment received from')
    expect(container.textContent).toContain('!')
  })

  test('renders actions if provided and showMoreInfo is true', () => {
    const actions = [
      {
        text: 'Action 1',
        isBold: true,
        actionText: 'Click Me',
        actionCallback: vi.fn()
      }
    ]
    render(
      <Toast label="Toast with actions" open={true} onClickClose={vi.fn()} actions={actions} />
    )

    // The action text and button should be visible.
    expect(screen.getByText('Action 1')).toBeInTheDocument()
    const actionButton = screen.getByText('Click Me')
    expect(actionButton).toBeInTheDocument()

    // Simulate clicking the action button.
    fireEvent.click(actionButton)
    expect(actions[0].actionCallback).toHaveBeenCalled()
  })

  test('temporarily hides actions when label includes "Request sent to"', async () => {
    const actions = [
      {
        text: 'Action 1',
        actionText: 'Click Me',
        actionCallback: vi.fn()
      }
    ]
    render(
      <Toast label="Request sent to user" open={true} onClickClose={vi.fn()} actions={actions} />
    )

    // Because the label includes "Request sent to", the useEffect hides actions initially.
    expect(screen.queryByText('Action 1')).not.toBeInTheDocument()

    // Advance timers by 3000ms so that showMoreInfo becomes true.
    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(screen.getByText('Action 1')).toBeInTheDocument()
  })

  test('renders open wallet action button if not mobile and openWalletAction is provided', () => {
    // By default, our isMobileOS mock returns false (non-mobile).
    const openWalletAction = vi.fn()
    render(
      <Toast
        label="Test Toast"
        open={true}
        onClickClose={vi.fn()}
        openWalletAction={openWalletAction}
      />
    )

    // The "Open Wallet" button should be rendered.
    const openWalletButton = screen.getByText(/Open Wallet/i)
    expect(openWalletButton).toBeInTheDocument()

    // Simulate clicking the open wallet button.
    fireEvent.click(openWalletButton)
    expect(openWalletAction).toHaveBeenCalled()
  })

  test('does not render open wallet action button on mobile', () => {
    // Override the isMobileOS mock to simulate a mobile OS.
    ;(isMobileOS as Mock).mockReturnValue(true)
    const openWalletAction = vi.fn()
    render(
      <Toast
        label="Test Toast"
        open={true}
        onClickClose={vi.fn()}
        openWalletAction={openWalletAction}
      />
    )
    // On mobile, the "Open Wallet" button should not be rendered.
    expect(screen.queryByText(/Open Wallet/i)).not.toBeInTheDocument()
  })

  test('applies default drag transform style', () => {
    // Since useDrag is mocked to return a function that returns an empty object,
    // the initial position remains [0, 0] so the transform should be translate3d(0px, 0px, 0)
    const { container } = render(<Toast label="Test Toast" open={true} onClickClose={vi.fn()} />)
    expect(container.firstChild).toHaveStyle('transform: translate3d(0px, 0px, 0)')
  })

  test('does not set inline position: absolute or minWidth: 460 so CSS position: fixed and responsive width govern layout', () => {
    const { container } = render(<Toast label="Test Toast" open={true} onClickClose={vi.fn()} />)
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.style.position).not.toBe('absolute')
    expect(wrapper.style.minWidth).toBe('')
  })

  test('immediately restores actions and clears the 3000ms timer when transitioning from "Request sent to" to another label', () => {
    const actions = [
      {
        text: 'Action 1',
        actionText: 'Reset Connection',
        actionCallback: vi.fn()
      }
    ]
    const { rerender } = render(
      <Toast label="Request sent to user" open={true} onClickClose={vi.fn()} actions={actions} />
    )

    expect(screen.queryByText('Action 1')).not.toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(1)

    // Before 3000ms elapses, the toast transitions to "Awaiting confirmation in Wallet"
    act(() => {
      vi.advanceTimersByTime(200)
      rerender(
        <Toast
          label="Awaiting confirmation in Wallet"
          open={true}
          onClickClose={vi.fn()}
          actions={actions}
        />
      )
    })

    // Actions should immediately be visible and the 3000ms timer must be cleaned up
    expect(screen.getByText('Action 1')).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('resets both Toast drag position and useDrag internal offset when toast closes and reopens', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1280 })
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 720 })

    const { container, rerender } = render(
      <Toast label="Test Toast" open={true} onClickClose={vi.fn()} />
    )
    const wrapper = container.firstChild as HTMLElement

    // Stub bounding rect at top-right (width 460, height 60, right 12, top 12 -> left 808)
    vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
      x: 808,
      y: 12,
      left: 808,
      top: 12,
      right: 1268,
      bottom: 72,
      width: 460,
      height: 60,
      toJSON: () => ({})
    })

    // Drag left by 100px and down by 80px
    fireEvent.mouseDown(wrapper, { clientX: 900, clientY: 30 })
    fireEvent.mouseMove(document, { clientX: 800, clientY: 110 })
    fireEvent.mouseUp(document)
    expect(wrapper).toHaveStyle('transform: translate3d(-100px, 80px, 0)')

    // Close and reopen the toast
    act(() => {
      rerender(<Toast label="Test Toast" open={false} onClickClose={vi.fn()} />)
    })
    act(() => {
      rerender(<Toast label="Test Toast" open={true} onClickClose={vi.fn()} />)
    })

    expect(wrapper).toHaveStyle('transform: translate3d(0px, 0px, 0)')

    // Start a new drag by (-10px, +15px): must start from [0, 0] rather than snapping back to [-100, 80]
    fireEvent.mouseDown(wrapper, { clientX: 900, clientY: 30 })
    fireEvent.mouseMove(document, { clientX: 890, clientY: 45 })
    fireEvent.mouseUp(document)
    expect(wrapper).toHaveStyle('transform: translate3d(-10px, 15px, 0)')
  })
})
