import { test, expect, Page, BrowserContext } from '@playwright/test'
import { pairWithWCWallet, pairWithWCWalletExpectRejection } from './utils'

/**
 * Regression coverage for the dapp-init promise unwedge fix.
 *
 * Before the fix, when a WalletConnect wallet rejected the session proposal,
 * the dapp's wcToastHandler emitted a PERMISSION_REQUEST_ERROR event but the
 * `_initPromise` was left dangling. `await dapp.requestPermissions()` hung
 * forever, `isInitPending` stayed `true`, and a subsequent click on the same
 * dapp instance entered an inconsistent transport-reuse state that prevented
 * any new request from reaching the wallet.
 *
 * These tests also guard against a second class of bug fixed in the same PR:
 * each request method historically used a `res.catch(handler)` whose handler
 * threw via `handleRequestError`. The catch returned a detached promise that
 * was never awaited, leaking an UnhandledPromiseRejection on every rejection.
 * The init-rejection path activates that bug reliably; the
 * `unhandledRejections` sentinel below catches a regression at any of the
 * seven structurally-identical catch sites.
 */

let dapp: Page = {} as unknown as Page
let dappCtx: BrowserContext = {} as unknown as BrowserContext
let wallet: Page = {} as unknown as Page
let walletCtx: BrowserContext = {} as unknown as BrowserContext

/**
 * Buffer of unhandled promise rejections + page errors seen on the dapp page
 * during the test. We assert it stays empty at the end of each scenario.
 */
let unhandledRejections: { type: 'pageerror' | 'unhandledrejection'; detail: string }[] = []

const attachUnhandledRejectionSentinel = async (page: Page) => {
  page.on('pageerror', (err) => {
    unhandledRejections.push({ type: 'pageerror', detail: err?.message ?? String(err) })
  })
  // Pre-flight install of an `unhandledrejection` listener inside the page.
  // Playwright's `pageerror` event covers thrown Errors but not raw promise
  // rejections, so we pipe `unhandledrejection` events back via console.
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().startsWith('UNHANDLED_PROMISE_REJECTION:')) {
      unhandledRejections.push({
        type: 'unhandledrejection',
        detail: msg.text().slice('UNHANDLED_PROMISE_REJECTION:'.length).trim()
      })
    }
  })
  await page.addInitScript(() => {
    window.addEventListener('unhandledrejection', (ev) => {
      const reason = ev.reason
      let payload: string
      try {
        payload =
          reason instanceof Error
            ? `${reason.name}: ${reason.message}`
            : typeof reason === 'object' && reason !== null
              ? JSON.stringify(reason)
              : String(reason)
      } catch {
        payload = '<unserializable rejection>'
      }
      // Tag the message so the Node-side listener can filter it.
      console.error('UNHANDLED_PROMISE_REJECTION:' + payload)
    })
  })
}

test.beforeEach(async ({ browser }) => {
  unhandledRejections = []
  ;[dapp, dappCtx, wallet, walletCtx] = await pairWithWCWalletExpectRejection(browser, {
    beforeDappLoad: attachUnhandledRejectionSentinel
  })
})

test.afterEach(async () => {
  await Promise.all([dappCtx.close(), walletCtx.close()])
})

test('rejection surfaces ABORTED_ERROR to the dapp instead of hanging', async () => {
  // The dapp's catch handler writes the error type to #lastPermissionError.
  // Pre-fix this never fired because the promise hung; post-fix it should
  // appear within the standard request timeout.
  await expect(dapp.locator('#lastPermissionError')).toHaveText('ABORTED_ERROR', {
    timeout: 30_000
  })

  // No active account should be set after a rejection.
  await expect(dapp.locator('#activeAccount')).toHaveText('', { timeout: 5_000 })

  const activeAccount = await dapp.evaluate(() =>
    window.localStorage.getItem('beacon:active-account')
  )
  expect(activeAccount).toBe('undefined')

  // Settle pending microtasks so any unhandled rejection has a chance to fire.
  await dapp.waitForTimeout(500)

  // No detached promise rejection from the requestPermissions catch chain.
  // Pre-fix `handleRequestError`'s thrown wrapped error escaped via the
  // discarded `res.catch(handler)` and surfaced here.
  expect(unhandledRejections).toEqual([])
})

test('PERMISSION_REQUEST_ERROR fires once with the full ErrorResponse payload', async () => {
  // Pre-fix wcToastHandler emitted PERMISSION_REQUEST_ERROR directly with a
  // sparse payload `{ errorType: ABORTED_ERROR }`, then handleRequestError
  // emitted it again with the full ErrorResponse — two events per
  // rejection, two different shapes. Post-fix the wcToastHandler emit was
  // removed; only handleRequestError emits, with the full shape.
  //
  // This test locks in:
  //   - Exactly one PERMISSION_REQUEST_ERROR event per rejection
  //   - Payload includes type/id/senderId/version/errorType (ErrorResponse
  //     contract used elsewhere in the dapp)
  //   - errorType is ABORTED_ERROR for a wallet session-proposal rejection
  await expect(dapp.locator('#lastPermissionError')).toHaveText('ABORTED_ERROR', {
    timeout: 30_000
  })

  // Settle anything queued by the rejection so a duplicate emit would land.
  await dapp.waitForTimeout(500)

  const eventCount = parseInt(
    (await dapp.locator('#permissionErrorCount').textContent()) || '0',
    10
  )
  expect(eventCount).toBe(1)

  const payloadJson = await dapp.locator('#permissionErrorPayload').textContent()
  expect(payloadJson).toBeTruthy()
  const payload = JSON.parse(payloadJson!)
  expect(payload).toMatchObject({
    type: 'error',
    errorType: 'ABORTED_ERROR'
  })
  // Other fields exist (senderId is generated, version is '2'). Present, not asserted on value.
  expect(payload).toHaveProperty('senderId')
  expect(payload).toHaveProperty('version')

  expect(unhandledRejections).toEqual([])
})

test.describe('post-pairing operation rejection', () => {
  let opDapp: Page = {} as unknown as Page
  let opDappCtx: BrowserContext = {} as unknown as BrowserContext
  let opWallet: Page = {} as unknown as Page
  let opWalletCtx: BrowserContext = {} as unknown as BrowserContext
  let opUnhandled: { type: 'pageerror' | 'unhandledrejection'; detail: string }[] = []

  test.beforeEach(async ({ browser }) => {
    opUnhandled = []
    ;[opDapp, opDappCtx, opWallet, opWalletCtx] = await pairWithWCWallet(browser, {
      beforeDappLoad: async (page) => {
        page.on('pageerror', (err) => {
          opUnhandled.push({ type: 'pageerror', detail: err?.message ?? String(err) })
        })
        page.on('console', (msg) => {
          if (msg.type() === 'error' && msg.text().startsWith('UNHANDLED_PROMISE_REJECTION:')) {
            opUnhandled.push({
              type: 'unhandledrejection',
              detail: msg.text().slice('UNHANDLED_PROMISE_REJECTION:'.length).trim()
            })
          }
        })
        await page.addInitScript(() => {
          window.addEventListener('unhandledrejection', (ev) => {
            const reason = ev.reason
            let payload: string
            try {
              payload =
                reason instanceof Error
                  ? `${reason.name}: ${reason.message}`
                  : typeof reason === 'object' && reason !== null
                    ? JSON.stringify(reason)
                    : String(reason)
            } catch {
              payload = '<unserializable rejection>'
            }
            console.error('UNHANDLED_PROMISE_REJECTION:' + payload)
          })
        })
      }
    })
  })

  test.afterEach(async () => {
    await Promise.all([opDappCtx.close(), opWalletCtx.close()])
  })

  test('wallet-rejected operation request rejects cleanly with no detached rejection', async () => {
    // Sanity: pairing succeeded.
    await expect(opDapp.locator('#activeAccount')).toHaveText(
      'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
      { timeout: 30_000 }
    )

    // Arm the wallet to reject the next session_request (tezos_send).
    await opWallet.click('#rejectNextOperation')

    // Trigger an operation. Pre-fix the requestOperation catch site at
    // DAppClient.ts had the same detached-rejection pattern as
    // requestPermissions, so the rejection from the wallet would emit an
    // unhandled promise rejection in addition to the dapp's own catch.
    // Post-fix the rejection is single-channel; the dapp's catch handler is
    // the only observer.
    await opDapp.click('#sendToSelf')

    // The dapp surfaces operation errors via #lastOperationError. The
    // wallet sends a JSON-RPC error code 5000 ("User rejected.") which the
    // beacon-sdk WC transport translates to ErrorResponse with errorType
    // ABORTED_ERROR.
    await expect(opDapp.locator('#lastOperationError')).toHaveText('ABORTED_ERROR', {
      timeout: 30_000
    })

    // Settle microtasks so any detached rejection has a chance to fire.
    await opDapp.waitForTimeout(500)
    expect(opUnhandled).toEqual([])
  })
})

test('after rejection, second requestPermissions can succeed', async () => {
  // Wait for the first rejection to propagate.
  await expect(dapp.locator('#lastPermissionError')).toHaveText('ABORTED_ERROR', {
    timeout: 30_000
  })

  // Start a second pairing attempt. Wallet flag is one-shot so it's now
  // back to auto-approve.
  await dapp.click('#requestPermission')
  await dapp.waitForSelector('div.alert-wrapper-show', { state: 'visible', timeout: 30_000 })

  await dapp.click('div.alert-footer')
  await dapp.click('button:has-text("Show QR code")')
  await dapp.waitForSelector('span.pair-other-info', { state: 'visible', timeout: 30_000 })

  await dapp.click('button:has-text("WalletConnect")')
  await dapp.waitForSelector('div.qr-right', { state: 'visible', timeout: 30_000 })
  await dapp.click('div.qr-right')

  await wallet.click('#paste')

  // Pre-fix this would have hung because the stale WC client was reused.
  // Post-fix the dapp should pair fresh and surface the wallet's address.
  await expect(dapp.locator('#activeAccount')).toHaveText('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', {
    timeout: 30_000
  })

  // The previous error indicator should clear once the new request starts.
  await expect(dapp.locator('#lastPermissionError')).toHaveText('', { timeout: 5_000 })

  await dapp.waitForTimeout(500)
  expect(unhandledRejections).toEqual([])
})
