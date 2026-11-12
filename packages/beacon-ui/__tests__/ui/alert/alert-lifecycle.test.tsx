import { act } from '@testing-library/react'

describe('Alert UI lifecycle (openAlert / closeAlert)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers()
    })
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  const getAlertShadowText = (): string => {
    const host = document.querySelector('beacon-alert')
    return host?.shadowRoot?.textContent ?? ''
  }

  const getAlertWrapper = (): HTMLElement | null => {
    const host = document.querySelector('beacon-alert')
    return (
      host?.shadowRoot?.querySelector<HTMLElement>('.alert-wrapper-show, .alert-wrapper-hide') ??
      null
    )
  }

  test('renders synchronously on first openAlert and respects immediate closeAlert within 50ms', async () => {
    const { openAlert, closeAlert } = await import('../../../src/ui/alert')

    await act(async () => {
      openAlert({ title: 'Test Alert Title', body: 'Test Alert Body' })
    })

    expect(getAlertShadowText()).toContain('Test Alert Title')
    expect(getAlertWrapper()).toHaveClass('alert-wrapper-show')

    await act(async () => {
      vi.advanceTimersByTime(10)
      closeAlert()
    })

    await act(async () => {
      vi.advanceTimersByTime(350)
    })

    expect(getAlertWrapper()).toBeNull()
  })

  test('cancels pending 300ms unmount timer when openAlert is called again before fade-out completes', async () => {
    const { openAlert, closeAlert } = await import('../../../src/ui/alert')

    await act(async () => {
      openAlert({ title: 'Initial Alert', body: 'Initial Body' })
      vi.advanceTimersByTime(100)
    })

    await act(async () => {
      closeAlert()
    })

    // Reopen after 150ms (while the 300ms fade-out unmount timer from closeAlert is still pending)
    await act(async () => {
      vi.advanceTimersByTime(150)
      openAlert({ title: 'Reopened Alert', body: 'Reopened Body' })
    })

    // Advance another 200ms (past the 300ms mark of the earlier closeAlert)
    await act(async () => {
      vi.advanceTimersByTime(200)
    })

    expect(getAlertShadowText()).toContain('Reopened Alert')
    expect(getAlertWrapper()).toHaveClass('alert-wrapper-show')
  })

  test('does not drop cold-start config updates emitted within 50ms of initial openAlert', async () => {
    const { openAlert } = await import('../../../src/ui/alert')

    await act(async () => {
      openAlert({ title: 'First Alert Title', body: 'First Body' })
      vi.advanceTimersByTime(10)
      openAlert({ title: 'Updated Alert Title', body: 'Updated Body' })
    })

    expect(getAlertShadowText()).toContain('Updated Alert Title')
    expect(getAlertShadowText()).toContain('Updated Body')
  })
})
