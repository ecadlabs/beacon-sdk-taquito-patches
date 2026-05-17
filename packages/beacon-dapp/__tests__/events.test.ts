import { openAlert } from '@ecadlabs/beacon-ui'
import { BeaconEvent, defaultEventCallbacks } from '../src/events'

jest.mock('@ecadlabs/beacon-ui', () => ({
  closeAlert: jest.fn(),
  closeToast: jest.fn(),
  isMobile: jest.fn().mockReturnValue(false),
  isMobileOS: jest.fn().mockReturnValue(false),
  openAlert: jest.fn(),
  openBugReport: jest.fn(),
  openToast: jest.fn()
}))

describe('default event callbacks', () => {
  beforeEach(() => {
    jest.clearAllMocks()
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
