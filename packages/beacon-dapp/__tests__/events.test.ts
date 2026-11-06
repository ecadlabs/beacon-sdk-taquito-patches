import { openAlert } from '@ecadlabs/beacon-ui'
import { BeaconEvent, defaultEventCallbacks } from '../src/events'

vi.mock('@ecadlabs/beacon-ui', () => ({
  closeAlert: vi.fn(),
  closeToast: vi.fn(),
  isMobile: vi.fn().mockReturnValue(false),
  isMobileOS: vi.fn().mockReturnValue(false),
  openAlert: vi.fn(),
  openToast: vi.fn()
}))

describe('default event callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows a usable generic error without a retired reporting action', async () => {
    await defaultEventCallbacks[BeaconEvent.GENERIC_ERROR]('Connection failed')

    expect(openAlert).toHaveBeenCalledWith({
      title: 'Connection failed',
      body: 'Please try again.'
    })
  })

  it('repairs a missing active account silently', async () => {
    await defaultEventCallbacks[BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]({
      reason: 'missing_active_account'
    })

    expect(openAlert).not.toHaveBeenCalled()
  })

  it('shows the expired-session modal for invalid account storage', async () => {
    await defaultEventCallbacks[BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]({
      reason: 'invalid_active_account_storage'
    })

    expect(openAlert).toHaveBeenCalledWith({
      title: 'Error',
      body: 'Your session has expired. Please pair with your wallet again.'
    })
  })
})
