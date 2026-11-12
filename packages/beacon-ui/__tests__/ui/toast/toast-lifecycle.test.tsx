import { act } from '@testing-library/react'

describe('Toast UI lifecycle (openToast / closeToast)', () => {
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

  const getToastShadowText = (): string => {
    const host = document.querySelector('beacon-toast')
    return host?.shadowRoot?.textContent ?? ''
  }

  const getToastWrapper = (): HTMLElement | null => {
    const host = document.querySelector('beacon-toast')
    return (
      host?.shadowRoot?.querySelector<HTMLElement>('.toast-wrapper-show, .toast-wrapper-hide') ??
      null
    )
  }

  test('renders synchronously on first openToast without a 50ms cold-start blank gap', async () => {
    const { openToast } = await import('../../../src/ui/toast')

    await act(async () => {
      openToast({ body: 'Preparing Request...', state: 'prepare' })
    })

    expect(getToastShadowText()).toContain('Preparing Request...')
    expect(getToastWrapper()).toHaveClass('toast-wrapper-show')
  })

  test('does not drop cold-start updates emitted within 50ms of initial openToast', async () => {
    const { openToast } = await import('../../../src/ui/toast')

    await act(async () => {
      openToast({ body: 'Preparing Request...', state: 'prepare' })
      vi.advanceTimersByTime(10)
      openToast({
        body: 'Request sent to {{wallet}}',
        state: 'loading',
        walletInfo: { name: 'Kukai' }
      })
    })

    // Advance past the stagger delay so the second toast update activates
    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    expect(getToastShadowText()).toContain('Request sent to')
    expect(getToastShadowText()).toContain('Kukai')
  })

  test('cold-start closeToast() within 50ms prevents the initial toast from remaining open', async () => {
    const { openToast, closeToast } = await import('../../../src/ui/toast')

    await act(async () => {
      openToast({ body: 'Preparing Request...', state: 'prepare' })
      vi.advanceTimersByTime(10)
      closeToast()
    })

    await act(async () => {
      vi.advanceTimersByTime(100)
    })

    expect(getToastWrapper()).toBeNull()
    expect(getToastShadowText()).not.toContain('Preparing Request...')
  })

  test('cancels pending stagger timers when closeToast() is called during rapid transitions', async () => {
    const { openToast, closeToast } = await import('../../../src/ui/toast')

    await act(async () => {
      // 1. SHOW_PREPARE (t = 0)
      openToast({ body: 'Preparing Request...', state: 'prepare' })
      vi.advanceTimersByTime(50)

      // 2. OPERATION_REQUEST_SENT (t = 50ms, queues delayed config$.next)
      openToast({
        body: 'Request sent to {{wallet}}',
        state: 'loading',
        walletInfo: { name: 'Kukai' }
      })
      vi.advanceTimersByTime(50)

      // 3. ACKNOWLEDGE_RECEIVED (t = 100ms, queues another delayed config$.next)
      openToast({
        body: 'Awaiting confirmation in {{wallet}}',
        state: 'acknowledge',
        walletInfo: { name: 'Kukai' }
      })
      vi.advanceTimersByTime(50)

      // 4. HIDE_UI / closeToast (t = 150ms, before 500ms/600ms stagger timers fire)
      closeToast()
    })

    // Advance past all 500ms/600ms stagger delays
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    expect(getToastWrapper()).toBeNull()
    expect(getToastShadowText()).not.toContain('Request sent to')
    expect(getToastShadowText()).not.toContain('Awaiting confirmation')
  })

  test('starts auto-close timer when a staggered toast actually activates rather than closing before it appears', async () => {
    const { openToast } = await import('../../../src/ui/toast')

    await act(async () => {
      openToast({ body: 'Preparing Request...', state: 'prepare' })
      vi.advanceTimersByTime(50)
      // Second call within cooldown has a 500ms stagger delay and a 400ms auto-close timer
      openToast({ body: 'Request finished', state: 'finished', timer: 400 })
    })

    // At +500ms the second toast should become visible
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(getToastShadowText()).toContain('Request finished')

    // 400ms after becoming visible, it should auto-close
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(getToastWrapper()).toBeNull()
  })

  test('clears pending auto-close timer immediately when closeToast() is called so no dangling timers remain', async () => {
    const { openToast, closeToast } = await import('../../../src/ui/toast')

    await act(async () => {
      openToast({ body: 'Timed toast', state: 'finished', timer: 5000 })
      vi.advanceTimersByTime(100)
    })

    await act(async () => {
      closeToast()
    })

    // After closeToast() completes (and any exit animation settles), zero pending timers should remain
    expect(vi.getTimerCount()).toBe(0)
  })

  test('resets stagger cooldown on closeToast() so a subsequent openToast() within 2000ms opens immediately', async () => {
    const { openToast, closeToast } = await import('../../../src/ui/toast')

    await act(async () => {
      openToast({ body: 'First operation', state: 'prepare' })
      vi.advanceTimersByTime(100)
      closeToast()
    })

    // 200ms later (well within 2000ms COOLDOWN), user triggers a second operation
    await act(async () => {
      vi.advanceTimersByTime(200)
      openToast({ body: 'Second operation', state: 'prepare' })
    })

    // Must appear immediately at 0ms without a 500ms stagger delay
    expect(getToastShadowText()).toContain('Second operation')
    expect(getToastWrapper()).toHaveClass('toast-wrapper-show')
  })

  test('clears superseded stagger timers when a new immediate openToast() arrives after cooldown', async () => {
    const { openToast } = await import('../../../src/ui/toast')

    await act(async () => {
      // Build up a stagger delay > 2000ms COOLDOWN (20 rapid calls -> timeoutDelay = 500 + 18 * 100 = 2300ms)
      for (let i = 1; i <= 20; i++) {
        openToast({ body: `Burst toast ${i}`, state: 'loading' })
      }
    })

    // Advance 2050ms (> 2000ms COOLDOWN, but before the 2300ms stagger timer from Burst toast 20 has fired)
    await act(async () => {
      vi.advanceTimersByTime(2050)
      openToast({ body: 'Fresh operation after cooldown', state: 'prepare' })
    })

    expect(getToastShadowText()).toContain('Fresh operation after cooldown')

    // Advance another 500ms (past the 2300ms mark of the stale burst timer)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    // The stale burst timer must NOT overwrite the newer toast
    expect(getToastShadowText()).toContain('Fresh operation after cooldown')
    expect(getToastShadowText()).not.toContain('Burst toast 20')
  })
})
