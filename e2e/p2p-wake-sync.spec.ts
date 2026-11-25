import { test, expect, type BrowserContext, type Page, type Request } from '@playwright/test'
import { pairWithBeaconWallet } from './utils'

/**
 * Deterministic regression coverage for post-pairing Matrix /sync wake recovery
 * via visibilitychange and the default Beacon toast transitions (sent ->
 * acknowledged -> terminal response). True OS-level TCP socket suspension and
 * mobile lock-screen behavior remain covered by manual device QA.
 */

const WAKE_RECOVERY_TIMEOUT_MS = 5_000

const waitWithDeadline = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

declare const client: {
  respond(response: unknown): Promise<void>
}

test('recovers from a stalled Matrix /sync after background and foreground wake and shows request UI transitions', async ({
  browser
}) => {
  let dapp: Page | undefined
  let dappCtx: BrowserContext | undefined
  let wallet: Page | undefined
  let walletCtx: BrowserContext | undefined

  let shouldStallSync = true
  let stalledSyncRequest: Request | undefined
  let stalledSyncEnteredResolve: () => void = () => undefined
  const stalledSyncEntered = new Promise<void>((resolve) => {
    stalledSyncEnteredResolve = resolve
  })
  let releaseStalledSync: () => void = () => undefined
  const stalledSyncGate = new Promise<void>((resolve) => {
    releaseStalledSync = resolve
  })

  let resumedSyncCount = 0
  let resumedSyncResolve: () => void = () => undefined
  const resumedSyncStarted = new Promise<void>((resolve) => {
    resumedSyncResolve = resolve
  })

  let abortedStalledSyncResolve: () => void = () => undefined
  const abortedStalledSync = new Promise<void>((resolve) => {
    abortedStalledSyncResolve = resolve
  })

  let holdAckSend = true
  let releaseAck: () => void = () => undefined
  const ackGate = new Promise<void>((resolve) => {
    releaseAck = resolve
  })

  try {
    ;[dapp, dappCtx, wallet, walletCtx] = await pairWithBeaconWallet(browser)

    dapp.on('requestfailed', (request) => {
      if (stalledSyncRequest && request === stalledSyncRequest) {
        abortedStalledSyncResolve()
      }
    })

    await dapp.route('**/_matrix/client/r0/sync*', async (route) => {
      if (shouldStallSync) {
        shouldStallSync = false
        stalledSyncRequest = route.request()
        stalledSyncEnteredResolve()
        await stalledSyncGate
        await route.abort().catch(() => undefined)

        return
      }

      resumedSyncCount += 1
      if (resumedSyncCount === 1) {
        resumedSyncResolve()
      }
      await route.continue()
    })

    // Hold the wallet's application-level respond() until the dApp has visibly rendered
    // the automatic AcknowledgeResponse toast. Because WalletClient sends ACK internally
    // via respondToMessage(), the only Matrix /send/ while respond() is gated is the ACK.
    await wallet.evaluate(() => {
      let releaseRespond: () => void = () => undefined
      const respondGate = new Promise<void>((resolve) => {
        releaseRespond = resolve
      })
      const originalRespond = client.respond.bind(client)
      client.respond = async (response: unknown) => {
        await respondGate
        return originalRespond(response)
      }
      Object.defineProperty(window, '__releaseWalletRespond', {
        configurable: true,
        value: releaseRespond
      })
    })

    await wallet.route('**/_matrix/client/r0/rooms/*/send/**', async (route) => {
      if (holdAckSend) {
        holdAckSend = false
        await ackGate
      }
      await route.continue()
    })

    // Wait past MIN_WAKE_SYNC_AGE_MS (1000ms); if a /sync was already in flight before
    // route attachment, rotate it once so the stalled /sync enters our route handler.
    await Promise.race([stalledSyncEntered, dapp.waitForTimeout(1100)])
    if (!stalledSyncRequest) {
      await dapp.evaluate(() => {
        window.dispatchEvent(new Event('online'))
      })
    }
    await stalledSyncEntered

    // Simulate backgrounding the dApp tab immediately after pairing.
    await dapp.evaluate(() => {
      let state: DocumentVisibilityState = 'hidden'
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state
      })
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => state !== 'visible'
      })
      Object.defineProperty(window, '__setTestVisibilityState', {
        configurable: true,
        value: (next: DocumentVisibilityState) => {
          state = next
          document.dispatchEvent(new Event('visibilitychange'))
        }
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    // Hold in background past MIN_WAKE_SYNC_AGE_MS (1000ms) while confirming hidden does not abort.
    await dapp.waitForTimeout(1100)
    expect(resumedSyncCount).toBe(0)

    // Foreground the dApp tab and assert both cancellation of the exact stalled Request
    // and issuance of the replacement /sync happen within a tight bounded deadline.
    const wakeStartedAt = Date.now()
    await dapp.evaluate(() => {
      const setState: unknown = Reflect.get(window, '__setTestVisibilityState')
      if (typeof setState !== 'function') {
        throw new Error('Missing __setTestVisibilityState helper')
      }
      setState('visible')
    })

    await Promise.all([
      waitWithDeadline(
        abortedStalledSync,
        WAKE_RECOVERY_TIMEOUT_MS,
        'stalled /sync request cancellation on wake'
      ),
      waitWithDeadline(
        resumedSyncStarted,
        WAKE_RECOVERY_TIMEOUT_MS,
        'replacement /sync request after wake'
      )
    ])
    expect(Date.now() - wakeStartedAt).toBeLessThan(WAKE_RECOVERY_TIMEOUT_MS)
    expect(resumedSyncCount).toBeGreaterThanOrEqual(1)
    releaseStalledSync()

    // Send a request and verify each visible toast transition: sent -> acknowledged -> response.
    await dapp.click('#sendToSelf')

    const toastLabel = dapp.locator('beacon-toast .toast-label')
    const toastWallet = dapp.locator('beacon-toast .toast-wallet-inline')

    await expect(toastLabel.filter({ hasText: /Request sent to/i })).toBeVisible({
      timeout: 30_000
    })
    await expect(toastWallet.filter({ hasText: /Example Wallet/ })).toBeVisible({
      timeout: 30_000
    })

    releaseAck()
    await expect(toastLabel.filter({ hasText: /Awaiting confirmation in/i })).toBeVisible({
      timeout: 30_000
    })
    await expect(toastWallet.filter({ hasText: /Example Wallet/ })).toBeVisible({
      timeout: 30_000
    })

    await wallet.evaluate(() => {
      const release: unknown = Reflect.get(window, '__releaseWalletRespond')
      if (typeof release !== 'function') {
        throw new Error('Missing __releaseWalletRespond helper')
      }
      release()
    })

    await expect(toastLabel.filter({ hasText: /has returned an error/i })).toBeVisible({
      timeout: 30_000
    })
    await expect(
      dapp.locator('beacon-toast .toast-action-label').filter({ hasText: /^Aborted$/ })
    ).toBeVisible({ timeout: 30_000 })
    await expect(dapp.locator('#lastOperationError')).toHaveText('ABORTED_ERROR', {
      timeout: 30_000
    })
  } finally {
    releaseStalledSync()
    releaseAck()
    if (wallet && !wallet.isClosed()) {
      await wallet
        .evaluate(() => {
          const release: unknown = Reflect.get(window, '__releaseWalletRespond')
          if (typeof release === 'function') {
            release()
          }
        })
        .catch(() => undefined)
      await wallet.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined)
    }
    if (dapp && !dapp.isClosed()) {
      await dapp.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined)
    }
    await Promise.all([dappCtx?.close(), walletCtx?.close()])
  }
})
