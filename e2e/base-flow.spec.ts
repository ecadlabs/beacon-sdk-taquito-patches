// e2e/flow.spec.ts
import { test, expect, BrowserContext } from '@playwright/test'
import { Serializer } from '@ecadlabs/beacon-core'

let dappCtx: BrowserContext = {} as BrowserContext

test.beforeEach(async ({ browser }) => {
  dappCtx = await browser.newContext()
  await dappCtx.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://localhost:1234'
  })
})

test.afterEach(async () => {
  await dappCtx.close()
})

test('opens the configured Kukai Ghostnet URL with this dApp pairing request', async () => {
  // Stub the external page response; the SDK still generates the URL and pairing request.
  await dappCtx.route('https://ghostnet.kukai.app/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Kukai pairing target</title>'
    })
  )

  const dapp = await dappCtx.newPage()
  await dapp.goto('http://localhost:1234/dapp.html')
  await dapp.getByRole('button', { name: 'Request Permission', exact: true }).click()
  await expect(dapp.locator('div.alert-wrapper-show')).toBeVisible()
  await dapp.getByRole('heading', { name: 'Kukai', exact: true }).click()
  await expect(dapp.locator('div.info-wrapper')).toBeVisible()
  await expect(dapp.locator('div.qr-wrapper')).toBeVisible()

  const identity = await dapp.evaluate<{ name: string; publicKey: string }>(
    '(async () => ({ name: client.name, publicKey: await client.beaconId }))()'
  )
  const popup = dapp.waitForEvent('popup')
  await dapp.getByRole('button', { name: 'Use Browser', exact: true }).click()
  const walletPage = await popup
  await expect(walletPage).toHaveURL(/^https:\/\/ghostnet\.kukai\.app\//)
  await expect(walletPage).toHaveTitle('Kukai pairing target')

  const walletUrl = new URL(walletPage.url())
  expect(walletUrl.pathname).toBe('/')
  expect(walletUrl.searchParams.get('type')).toBe('tzip10')
  const pairingCode = walletUrl.searchParams.get('data')
  expect(pairingCode).toBeTruthy()
  const pairingRequest = await new Serializer().deserialize(pairingCode ?? '')
  expect(pairingRequest).toEqual(
    expect.objectContaining({
      id: expect.stringMatching(/\S/),
      name: identity.name,
      publicKey: identity.publicKey,
      relayServer: expect.stringMatching(/\S/),
      type: 'p2p-pairing-request',
      version: expect.stringMatching(/\S/)
    })
  )
})

test('should display AirGap QR code and copy pairing code to clipboard', async () => {
  const dapp = await dappCtx.newPage()
  await dapp.goto('http://localhost:1234/dapp.html')

  // --- trigger the Beacon pairing alert ---
  await dapp.click('#requestPermission')
  await dapp.waitForSelector('div.alert-wrapper-show', { state: 'visible', timeout: 30_000 })

  // --- choose AirGap and wait for QR display ---
  await dapp.click('h3:has-text("AirGap")')
  await dapp.waitForSelector('div.qr-right', { state: 'visible', timeout: 30_000 })

  // --- click the QR element to copy the pairing code ---
  await dapp.click('div.qr-right')

  // --- read back from the clipboard in the page context ---
  const pairingCode = await dapp.evaluate(async () => {
    return await navigator.clipboard.readText()
  })

  expect(pairingCode).toBeTruthy()
})

test('should display Temple Wallet', async () => {
  const dapp = await dappCtx.newPage()
  await dapp.goto('http://localhost:1234/dapp.html')

  // --- trigger the Beacon pairing alert ---
  await dapp.click('#requestPermission')
  await dapp.waitForSelector('div.alert-wrapper-show', { state: 'visible', timeout: 30_000 })

  await dapp.click('div.alert-footer')
  await dapp.waitForSelector('div.wallets-list-wrapper', { state: 'visible', timeout: 30_000 })

  await dapp.click('h3:has-text("Temple")')

  await dapp.waitForSelector('h3:has-text("Install Temple Wallet")', {
    state: 'visible',
    timeout: 30_000
  })
  ;(await dapp.waitForSelector('div.qr-wrapper', {
    state: 'visible',
    timeout: 30_000
  })) as unknown as HTMLElement

  // TODO extension pairing??
})

test('should pair other with Beacon', async () => {
  const dapp = await dappCtx.newPage()
  await dapp.goto('http://localhost:1234/dapp.html')

  // --- trigger the Beacon pairing alert ---
  await dapp.click('#requestPermission')
  await dapp.waitForSelector('div.alert-wrapper-show', { state: 'visible', timeout: 30_000 })

  // --- choose AirGap and wait for QR display ---
  await dapp.click('div.alert-footer')
  await dapp.click('button:has-text("Show QR code")')
  await dapp.waitForSelector('span.pair-other-info', { state: 'visible', timeout: 30_000 })

  await dapp.click('button:has-text("Beacon")')

  await dapp.waitForSelector('div.qr-right', { state: 'visible', timeout: 30_000 })

  // --- click the QR element to copy the pairing code ---
  await dapp.click('div.qr-right')

  // --- read back from the clipboard in the page context ---
  const pairingCode = await dapp.evaluate(async () => {
    return await navigator.clipboard.readText()
  })

  expect(pairingCode).toBeTruthy()
})

test('should pair other with WalletConnect', async () => {
  const dapp = await dappCtx.newPage()
  await dapp.goto('http://localhost:1234/dapp.html')

  // --- trigger the Beacon pairing alert ---
  await dapp.click('#requestPermission')
  await dapp.waitForSelector('div.alert-wrapper-show', { state: 'visible', timeout: 30_000 })

  // --- choose AirGap and wait for QR display ---
  await dapp.click('div.alert-footer')
  await dapp.click('button:has-text("Show QR code")')
  await dapp.waitForSelector('span.pair-other-info', { state: 'visible', timeout: 30_000 })

  await dapp.click('button:has-text("WalletConnect")')

  await dapp.waitForSelector('div.qr-right', { state: 'visible', timeout: 30_000 })

  // --- click the QR element to copy the pairing code ---
  await dapp.click('div.qr-right')

  // --- read back from the clipboard in the page context ---
  const pairingCode = await dapp.evaluate(async () => {
    return await navigator.clipboard.readText()
  })

  expect(pairingCode).toBeTruthy()
})

test('should close the pairing alert', async () => {
  const dapp = await dappCtx.newPage()
  await dapp.goto('http://localhost:1234/dapp.html')

  // --- trigger the Beacon pairing alert ---
  await dapp.click('#requestPermission')
  await dapp.waitForSelector('div.alert-wrapper-show', { state: 'visible', timeout: 30_000 })

  await dapp.locator('div.button-icon').nth(0).click()

  await dapp.waitForSelector('div.alert-wrapper-show', { state: 'detached', timeout: 30_000 })
})

test('should show "No active account" error alert', async () => {
  const dapp = await dappCtx.newPage()
  await dapp.goto('http://localhost:1234/dapp.html')

  // --- trigger the Beacon pairing alert ---
  await dapp.click('#sendToSelf')
  await dapp.waitForSelector('div.alert-wrapper-show', { state: 'visible', timeout: 30_000 })

  // Scope the message-text assertion to the alert UI specifically. The dapp
  // page can have other visible divs containing "No active account"
  // (e.g. legacy unhandled-rejection logger output) that vary by setup;
  // we only care that the SDK alert renders the message.
  await expect(
    dapp.locator('div.alert-wrapper-show div.info-description')
  ).toContainText('No active account', { timeout: 30_000 })

  await dapp.click('button:has-text("Close")')

  await dapp.waitForSelector('div.alert-wrapper-show', { state: 'detached', timeout: 30_000 })
})
