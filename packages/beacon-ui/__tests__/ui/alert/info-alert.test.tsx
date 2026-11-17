import { render, screen, fireEvent } from '@testing-library/react'
import { InfoAlert } from '../../../src/ui/alert/components/info-alert'
import { ConfigurableAlertProps } from '../../../src/ui/common'

vi.mock('../../../src/ui/alert/hooks/useIsMobile', () => ({
  __esModule: true,
  useIsMobile: () => false
}))

describe('InfoAlert Component', () => {
  const onCloseMock = vi.fn()

  const defaultProps: ConfigurableAlertProps = {
    title: 'Test Title',
    body: 'Test description',
    data: 'Test data',
    open: true,
    onClose: onCloseMock,
    closeOnBackdropClick: true
  }

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('renders with provided title, body, and data', () => {
    render(<InfoAlert {...defaultProps} />)

    // Expect the title (rendered as a heading) to appear.
    expect(screen.getByRole('heading', { name: /Test Title/i })).toBeInTheDocument()
    // Expect the description to appear.
    expect(screen.getByText(/Test description/i)).toBeInTheDocument()
    // Expect the data to appear (if rendered as preformatted text or similar).
    expect(screen.getByText(/Test data/i)).toBeInTheDocument()
    // Expect the "Close" buttons (header icon button + primary info action button) to be present.
    const closeButtons = screen.getAllByRole('button', { name: /Close/i })
    expect(closeButtons.length).toBeGreaterThanOrEqual(2)
  })

  test('calls onClose when the "Close" button is clicked', () => {
    render(<InfoAlert {...defaultProps} />)

    // Find the primary "Close" button in InfoAlert and simulate a click.
    const closeButton = screen
      .getAllByRole('button', { name: /Close/i })
      .find((el) => el.classList.contains('info-button'))
    expect(closeButton).toBeDefined()
    fireEvent.click(closeButton!)
    expect(onCloseMock).toHaveBeenCalledTimes(1)
  })

  test('applies hidden class when open is false', () => {
    // Render the component with open={false}. Depending on your Alert implementation,
    // the Alert container may have a class like "alert-wrapper-hide" when closed.
    const { container } = render(<InfoAlert {...defaultProps} open={false} />)
    expect(container.firstChild).toHaveClass('alert-wrapper-hide')
  })
})
