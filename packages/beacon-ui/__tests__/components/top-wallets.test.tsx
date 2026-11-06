import { render, screen, fireEvent } from '@testing-library/react'
import TopWallets from '../../src/components/top-wallets/index'
import { MergedWallet } from 'src/utils/wallets'

// --- Mock the Wallet component ---
// Replace the real Wallet component with a dummy that renders a div with data-testid="wallet"
// and displays the wallet name and description.
vi.mock('../../src/components/wallet', () => {
  return {
    default: ({
      name,
      description,
      onClick
    }: {
      name: string
      description: string
      onClick: () => void
    }) => (
      <div data-testid="wallet" onClick={onClick}>
        <span>{name}</span>
        <span>{description}</span>
      </div>
    )
  }
})

describe('TopWallets Component', () => {
  // Dummy wallets array
  const dummyWallets: MergedWallet[] = [
    {
      id: 'wallet1',
      name: 'Wallet One',
      descriptions: ['Fast', 'Secure'],
      image: 'wallet1.png',
      tags: ['popular'],
      key: 'wallet1',
      links: [],
      types: []
    },
    {
      id: 'wallet2',
      name: 'Wallet Two',
      descriptions: ['Reliable'],
      image: 'wallet2.png',
      tags: ['new'],
      key: 'wallet2',
      links: [],
      types: []
    }
  ]

  // Dummy callbacks
  const onClickWallet = vi.fn()
  const dummyOtherWallets = {
    images: ['other1.png', 'other2.png', 'other3.png'],
    onClick: vi.fn()
  }

  // Before each test, clear localStorage and reset mocks
  beforeEach(() => {
    localStorage.clear()
    onClickWallet.mockClear()
    dummyOtherWallets.onClick.mockClear()
  })

  test('renders wallet selection without reporting controls even with a stale metrics preference', () => {
    localStorage.setItem('beacon:enable_metrics', 'true')
    render(<TopWallets wallets={dummyWallets} onClickWallet={onClickWallet} isMobile={false} />)

    expect(screen.getByRole('heading', { name: /Connect Wallet/i })).toBeInTheDocument()
    expect(screen.queryByText(/report a bug|Click here/i)).not.toBeInTheDocument()
  })

  test('renders a list of wallets and calls onClickWallet when a wallet is clicked', () => {
    render(<TopWallets wallets={dummyWallets} onClickWallet={onClickWallet} isMobile={false} />)
    // Our mocked Wallet renders elements with data-testid="wallet"
    const walletElements = screen.getAllByTestId('wallet')
    expect(walletElements).toHaveLength(dummyWallets.length)
    // Click the first wallet element
    fireEvent.click(walletElements[0])
    expect(onClickWallet).toHaveBeenCalledWith(dummyWallets[0].id)
  })

  test('renders the other wallets section if provided and calls its onClick handler', () => {
    render(
      <TopWallets
        wallets={dummyWallets}
        onClickWallet={onClickWallet}
        otherWallets={dummyOtherWallets}
        isMobile={false}
      />
    )
    // Instead of using getByText directly (which finds multiple matches),
    // get all elements that match /Other Wallets/i and then pick the heading element.
    const headings = screen.getAllByText(/Other Wallets/i)
    const otherHeading = headings.find((el) => el.tagName.toLowerCase() === 'h3')
    expect(otherHeading).toBeInTheDocument()
    // Get the container (closest element with class 'top-wallets-other-wallets')
    const otherSection = otherHeading?.closest('.top-wallets-other-wallets')
    expect(otherSection).toBeInTheDocument()
    if (otherSection) {
      fireEvent.click(otherSection)
      expect(dummyOtherWallets.onClick).toHaveBeenCalled()
    }
  })
})
