import { expect, test } from '@playwright/test'

declare const beacon: typeof import('@ecadlabs/beacon-sdk')

for (const stalled of [false, true]) {
  test(`cold Beacon QR with ${stalled ? 'a stalled second relay' : 'two healthy relays'}`, async ({
    page,
    context,
    browser
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.route('http://localhost:1234/first-pairing', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<button id="connect">Connect</button><script src="/walletbeacon.min.js"></script>'
      })
    )
    await page.goto('http://localhost:1234/first-pairing')
    await page.evaluate((stalled) => {
      const client = beacon.getDAppClientInstance({
        name: 'Cold pairing',
        featuredWallets: ['airgap'],
        matrixNodes: { [beacon.Regions.EUROPE_WEST]: ['fast.example', 'second.example'] }
      })
      const originalFetch = window.fetch.bind(window)
      window.fetch = async (input, options) => {
        const url = new URL(input instanceof Request ? input.url : input.toString(), location.href)
        if (!['fast.example', 'second.example'].includes(url.host))
          return originalFetch(input, options)
        if (url.pathname.endsWith('/info')) {
          performance.mark('probe:' + url.host)
          if (url.host === 'second.example' && stalled) {
            return new Promise<Response>((_, reject) => {
              options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
                once: true
              })
            })
          }
          await new Promise((resolve) =>
            setTimeout(resolve, url.host === 'fast.example' ? 250 : 500)
          )
          performance.mark('healthy:' + url.host)
          return Response.json({ timestamp: Date.now() / 1000, known_servers: [], region: 'eu' })
        }
        if (url.pathname.endsWith('/login')) {
          return Response.json({
            user_id: '@test:fast.example',
            device_id: 'test',
            access_token: 'test'
          })
        }
        if (url.pathname.endsWith('/sync')) {
          if (url.searchParams.has('since')) return new Promise<Response>(() => {})
          return Response.json({ next_batch: 'first', rooms: {} })
        }
        throw new Error('Unexpected Matrix request ' + url.pathname)
      }
      const store = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        if (key === beacon.StorageKey.MATRIX_SELECTED_NODE) performance.mark('selected')
        store.call(this, key, value)
      }
      document.getElementById('connect')!.onclick = () => {
        performance.mark('connect')
        const observe = () => {
          const root = document.querySelector('beacon-alert')?.shadowRoot
          const visible = (selector: string) =>
            root
              ?.querySelector(selector)
              ?.checkVisibility({ opacityProperty: true, visibilityProperty: true })
          if (visible('.wallet-main') && !performance.getEntriesByName('feedback').length)
            performance.mark('feedback')
          if (visible('.qr-svg-wrapper svg')) performance.mark('qr')
          else requestAnimationFrame(observe)
        }
        requestAnimationFrame(observe)
        void client.requestPermissions()
      }
    }, stalled)
    await page.getByText('Connect', { exact: true }).click()
    await page
      .getByRole('button', { name: /AirGap/ })
      .first()
      .click()
    await page.locator('.qr-svg-wrapper svg').waitFor()
    await page.waitForFunction(() => performance.getEntriesByName('qr').length > 0)
    const svg = page.locator('.qr-svg-wrapper svg')
    await test
      .info()
      .attach('displayed-qr', { body: await svg.screenshot(), contentType: 'image/png' })
    await page.locator('.qr-right').click()
    await test.info().attach('copied-code', {
      body: await page.evaluate(() => navigator.clipboard.readText()),
      contentType: 'text/plain'
    })
    const payload = await page.evaluate(async () =>
      new beacon.Serializer().deserialize(await navigator.clipboard.readText())
    )
    expect(payload).toMatchObject({
      name: 'Cold pairing',
      relayServer: 'fast.example',
      publicKey: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    const times = await page.evaluate(() => {
      const time = (mark: string) => Math.round(performance.getEntriesByName(mark)[0].startTime)
      return {
        probes: performance
          .getEntriesByType('mark')
          .filter((entry) => entry.name.startsWith('probe:'))
          .map((entry) => entry.name),
        feedback: time('feedback') - time('connect'),
        healthy: time('healthy:fast.example') - time('connect'),
        selected: time('selected') - time('connect'),
        qr: time('qr') - time('connect')
      }
    })
    console.log(browser.version(), { stalled, ...times })
    expect(times.probes).toContain('probe:fast.example')
    expect(times.probes).toContain('probe:second.example')
    if (!stalled) {
      const order = await page.evaluate(() =>
        performance
          .getEntriesByType('mark')
          .map((entry) => entry.name)
          .filter((name) => name === 'selected' || name === 'healthy:second.example')
      )
      expect(order).toEqual(['selected', 'healthy:second.example'])
    }
    expect.soft(times.qr - times.healthy).toBeLessThan(2000)
    expect(times.selected - times.healthy).toBeLessThan(1000)
  })
}

for (const view of ['install', 'other']) {
  test(`${view} gives QR feedback while the pairing payload is held`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('http://localhost:1234/dapp.html')
    const code = await page.evaluate(async () => {
      const code = await new beacon.Serializer().serialize({
        id: 'test',
        type: 'p2p-pairing-request',
        name: 'Test',
        version: '3',
        publicKey: '01'.repeat(32),
        relayServer: 'fast.example'
      })
      const p2pSyncCode = new Promise<string>((resolve) =>
        window.addEventListener('release-pairing', () => resolve(code), { once: true })
      )
      const wc = new Promise<string>(() => {})
      void beacon.openAlert({
        title: 'Connect',
        featuredWallets: ['airgap'],
        pairingPayload: {
          p2pSyncCode,
          postmessageSyncCode: Promise.resolve(''),
          walletConnectSyncCode: {
            then(onFulfilled, onRejected) {
              performance.mark('walletconnect-start')
              return wc.then(onFulfilled, onRejected)
            }
          },
          networkType: beacon.NetworkType.MAINNET
        }
      })
      return code
    })
    await page.evaluate(() => {
      document.addEventListener(
        'click',
        (event) => {
          if (
            !event
              .composedPath()
              .some(
                (el) =>
                  el instanceof HTMLElement &&
                  (el.matches('.wallet-main') ||
                    (el.tagName === 'BUTTON' && el.textContent?.includes('Show QR code')))
              )
          )
            return
          performance.mark('view-click')
          const observe = () => {
            const root = document.querySelector('beacon-alert')?.shadowRoot
            if (
              root?.textContent?.match(/Preparing [^{}]{0,50}QR/i) &&
              !performance.getEntriesByName('preparing').length
            )
              performance.mark('preparing')
            if (root?.querySelector('.qr-svg-wrapper svg')) performance.mark('view-qr')
            else requestAnimationFrame(observe)
          }
          requestAnimationFrame(observe)
        },
        true
      )
    })
    if (view === 'install') {
      await page
        .getByRole('button', { name: /AirGap/ })
        .first()
        .click()
    } else {
      await page.locator('.alert-footer').click()
      await page.getByRole('button', { name: 'Show QR code' }).click()
      await expect(page.getByText('Select QR Type')).toBeVisible()
    }
    const dialog = page.getByRole('dialog')
    console.log(view, {
      pendingText: await dialog.innerText(),
      busy: await dialog.getAttribute('aria-busy'),
      wcStarted: await page.evaluate(
        () => performance.getEntriesByName('walletconnect-start').length > 0
      )
    })
    // Soft assertion keeps the eventual QR and its payload under test on the baseline.
    await expect.soft(dialog.getByText(/preparing.*QR/i)).toBeVisible({ timeout: 1000 })
    await page.evaluate(() => window.dispatchEvent(new Event('release-pairing')))
    if (view === 'other') await page.getByRole('button', { name: 'Beacon', exact: true }).click()
    await expect(page.locator('.qr-svg-wrapper svg')).toBeVisible()
    await page.locator('.qr-right').click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code)
    await page.waitForFunction(() => performance.getEntriesByName('view-qr').length > 0)
    console.log(
      view,
      await page.evaluate(() => {
        const sinceClick = (name: string) => {
          const entry = performance.getEntriesByName(name)[0]
          return entry
            ? Math.round(entry.startTime - performance.getEntriesByName('view-click')[0].startTime)
            : null
        }
        return { preparing: sinceClick('preparing'), qr: sinceClick('view-qr') }
      })
    )
  })
}
