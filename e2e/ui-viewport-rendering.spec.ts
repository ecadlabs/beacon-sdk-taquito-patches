import { test, expect, Page } from '@playwright/test'

declare const beacon: typeof import('@ecadlabs/beacon-sdk')

interface ViewportProfile {
  name: string
  width: number
  height: number
  userAgent?: string
}

const IOS_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const ANDROID_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

const VIEWPORT_PROFILES: ViewportProfile[] = [
  { name: 'desktop-wide (1440x900)', width: 1440, height: 900 },
  { name: 'desktop-standard (1280x720)', width: 1280, height: 720 },
  { name: 'tablet-portrait (768x1024)', width: 768, height: 1024 },
  { name: 'desktop-narrow-responsive (375x667)', width: 375, height: 667 },
  { name: 'mobile-iphone-14 (390x844)', width: 390, height: 844, userAgent: IOS_USER_AGENT },
  { name: 'mobile-iphone-se (375x667)', width: 375, height: 667, userAgent: IOS_USER_AGENT },
  { name: 'mobile-galaxy-s21 (360x800)', width: 360, height: 800, userAgent: ANDROID_USER_AGENT },
  { name: 'mobile-small (320x568)', width: 320, height: 568, userAgent: IOS_USER_AGENT },
  { name: 'mobile-landscape-small (667x375)', width: 667, height: 375, userAgent: IOS_USER_AGENT },
  { name: 'mobile-landscape (844x390)', width: 844, height: 390, userAgent: IOS_USER_AGENT }
]

interface LayoutCheckResult {
  found: boolean
  position: string
  scrollY: number
  viewportWidth: number
  viewportHeight: number
  containerRect: {
    top: number
    left: number
    right: number
    bottom: number
    width: number
    height: number
  }
  horizontalOverflowPx: number
  closeButtonVisible: boolean
  closeButtonInBounds: boolean
  closeButtonHitTestable: boolean
  overflowingChildren: string[]
}

async function inspectToastLayout(page: Page): Promise<LayoutCheckResult> {
  return page.evaluate(() => {
    const host = document.querySelector('beacon-toast')
    const wrapper = host?.shadowRoot?.querySelector<HTMLElement>('.toast-wrapper-show')
    if (!host?.shadowRoot || !wrapper) {
      return {
        found: false,
        position: '',
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        containerRect: { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 },
        horizontalOverflowPx: 0,
        closeButtonVisible: false,
        closeButtonInBounds: false,
        closeButtonHitTestable: false,
        overflowingChildren: []
      }
    }

    const computed = window.getComputedStyle(wrapper)
    const rect = wrapper.getBoundingClientRect()
    const closeBtn = host.shadowRoot.querySelector<HTMLElement>('.button-icon')
    const closeRect = closeBtn?.getBoundingClientRect()

    let closeButtonHitTestable = false
    if (closeBtn && closeRect && closeRect.width > 0 && closeRect.height > 0) {
      const cx = closeRect.left + closeRect.width / 2
      const cy = closeRect.top + closeRect.height / 2
      const hitEl = host.shadowRoot.elementFromPoint(cx, cy)
      closeButtonHitTestable = Boolean(hitEl && (closeBtn === hitEl || closeBtn.contains(hitEl)))
    }

    const overflowingChildren: string[] = []
    const children = wrapper.querySelectorAll<HTMLElement>(
      '.toast-header, .toast-label, .toast-action-button, .button-icon, .toast-body, .toast-action-wrapper'
    )
    children.forEach((child) => {
      const cRect = child.getBoundingClientRect()
      if (cRect.width === 0 && cRect.height === 0) return
      if (
        cRect.left < rect.left - 1 ||
        cRect.right > rect.right + 1 ||
        cRect.top < rect.top - 1 ||
        cRect.bottom > rect.bottom + 1
      ) {
        overflowingChildren.push(
          `${child.className}: [${Math.round(cRect.left)},${Math.round(cRect.top)},${Math.round(cRect.right)},${Math.round(cRect.bottom)}] outside [${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.right)},${Math.round(rect.bottom)}]`
        )
      }
    })

    return {
      found: true,
      position: computed.position,
      scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      containerRect: {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      },
      horizontalOverflowPx: Math.max(0, wrapper.scrollWidth - wrapper.clientWidth),
      closeButtonVisible: Boolean(closeRect && closeRect.width >= 16 && closeRect.height >= 16),
      closeButtonInBounds: Boolean(
        closeRect &&
        closeRect.left >= rect.left - 1 &&
        closeRect.right <= rect.right + 1 &&
        closeRect.right <= window.innerWidth &&
        closeRect.top >= 0
      ),
      closeButtonHitTestable,
      overflowingChildren
    }
  })
}

async function inspectAlertLayout(page: Page): Promise<LayoutCheckResult> {
  return page.evaluate(() => {
    const host = document.querySelector('beacon-alert')
    const wrapper = host?.shadowRoot?.querySelector<HTMLElement>('.alert-wrapper-show')
    const modal = host?.shadowRoot?.querySelector<HTMLElement>('.alert-modal-show')
    if (!host?.shadowRoot || !wrapper || !modal) {
      return {
        found: false,
        position: '',
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        containerRect: { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 },
        horizontalOverflowPx: 0,
        closeButtonVisible: false,
        closeButtonInBounds: false,
        closeButtonHitTestable: false,
        overflowingChildren: []
      }
    }

    const wrapperComputed = window.getComputedStyle(wrapper)
    const rect = modal.getBoundingClientRect()
    const closeBtns = host.shadowRoot.querySelectorAll<HTMLElement>('.alert-header .button-icon')
    const closeBtn = closeBtns[closeBtns.length - 1]
    const closeRect = closeBtn?.getBoundingClientRect()

    let closeButtonHitTestable = false
    if (closeBtn && closeRect && closeRect.width > 0 && closeRect.height > 0) {
      const cx = closeRect.left + closeRect.width / 2
      const cy = closeRect.top + closeRect.height / 2
      const hitEl = host.shadowRoot.elementFromPoint(cx, cy)
      closeButtonHitTestable = Boolean(hitEl && (closeBtn === hitEl || closeBtn.contains(hitEl)))
    }

    const overflowingChildren: string[] = []
    const children = modal.querySelectorAll<HTMLElement>(
      '.alert-header, .alert-modal-loading-wrapper, .alert-body, .info-wrapper, .info-title, .info-description, .info-buttons, .info-button, .info-button-secondary, #qr-code-icon, .qr-wrapper, .qr-right, .qr-svg-wrapper'
    )
    children.forEach((child) => {
      const cRect = child.getBoundingClientRect()
      if (cRect.width === 0 && cRect.height === 0) return
      if (
        cRect.left < rect.left - 1 ||
        cRect.right > rect.right + 1 ||
        cRect.top < rect.top - 1 ||
        cRect.bottom > rect.bottom + 1
      ) {
        overflowingChildren.push(
          `${child.className || child.id}: [${Math.round(cRect.left)},${Math.round(cRect.top)},${Math.round(cRect.right)},${Math.round(cRect.bottom)}] outside modal [${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.right)},${Math.round(rect.bottom)}]`
        )
      }
    })

    // Also check if children of each .info-wrapper overflow outside that .info-wrapper itself
    modal.querySelectorAll<HTMLElement>('.info-wrapper').forEach((infoWrapper) => {
      const infoRect = infoWrapper.getBoundingClientRect()
      infoWrapper
        .querySelectorAll<HTMLElement>(
          '.info-title, .info-description, .info-buttons, .info-button, .info-button-secondary, #qr-code-icon'
        )
        .forEach((child) => {
          const cRect = child.getBoundingClientRect()
          if (cRect.width === 0 && cRect.height === 0) return
          if (
            cRect.left < infoRect.left - 1 ||
            cRect.right > infoRect.right + 1 ||
            cRect.top < infoRect.top - 1 ||
            cRect.bottom > infoRect.bottom + 1
          ) {
            overflowingChildren.push(
              `${child.className || child.id}: [${Math.round(cRect.left)},${Math.round(cRect.top)},${Math.round(cRect.right)},${Math.round(cRect.bottom)}] outside info-wrapper [${Math.round(infoRect.left)},${Math.round(infoRect.top)},${Math.round(infoRect.right)},${Math.round(infoRect.bottom)}]`
            )
          }
        })
    })

    return {
      found: true,
      position: wrapperComputed.position,
      scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      containerRect: {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      },
      horizontalOverflowPx: Math.max(0, modal.scrollWidth - modal.clientWidth),
      closeButtonVisible: Boolean(closeRect && closeRect.width >= 16 && closeRect.height >= 16),
      closeButtonInBounds: Boolean(
        closeRect &&
        closeRect.left >= rect.left - 1 &&
        closeRect.right <= rect.right + 1 &&
        closeRect.right <= window.innerWidth &&
        closeRect.top >= 0
      ),
      closeButtonHitTestable,
      overflowingChildren
    }
  })
}

test.describe('beacon-ui Desktop and Mobile Viewport Rendering & Scroll Conformance', () => {
  for (const profile of VIEWPORT_PROFILES) {
    test(`Toast stays fixed in viewport when scrolled and fits within ${profile.name}`, async ({
      browser
    }) => {
      const context = await browser.newContext({
        viewport: { width: profile.width, height: profile.height },
        ...(profile.userAgent ? { userAgent: profile.userAgent } : {})
      })
      const page = await context.newPage()
      try {
        await page.goto('http://localhost:1234/dapp.html')

        // Ensure document is tall enough to scroll on all viewport heights and scroll down 600px
        await page.evaluate(() => {
          document.body.style.minHeight = '3000px'
          window.scrollTo(0, 600)
        })

        // Open a realistic rich toast with wallet info, Open Wallet button, and expanded action row
        await page.evaluate(() => {
          beacon.openToast({
            body: 'Awaiting confirmation in {{wallet}}',
            state: 'acknowledge',
            walletInfo: {
              name: 'Kukai Wallet',
              icon: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
            },
            openWalletAction: () => {},
            actions: [
              {
                text: 'Wallet not receiving request?',
                isBold: true,
                actionText: 'Reset Connection',
                actionCallback: () => {}
              }
            ]
          })
        })

        // Wait for entrance animation to finish
        await page.waitForTimeout(400)

        const layout = await inspectToastLayout(page)
        expect(layout.found).toBe(true)
        expect(layout.scrollY).toBeGreaterThanOrEqual(500)
        expect(layout.position).toBe('fixed')
        expect(layout.containerRect.top).toBeGreaterThanOrEqual(0)
        expect(layout.containerRect.left).toBeGreaterThanOrEqual(0)
        expect(layout.containerRect.right).toBeLessThanOrEqual(profile.width)
        expect(layout.containerRect.bottom).toBeLessThanOrEqual(profile.height)
        expect(layout.horizontalOverflowPx).toBeLessThanOrEqual(1)
        expect(layout.closeButtonVisible).toBe(true)
        expect(layout.closeButtonInBounds).toBe(true)
        expect(layout.closeButtonHitTestable).toBe(true)
        expect(layout.overflowingChildren).toEqual([])
      } finally {
        await context.close()
      }
    })

    test(`Alert modal fits within ${profile.name} without child or button overflow when scrolled`, async ({
      browser
    }) => {
      const context = await browser.newContext({
        viewport: { width: profile.width, height: profile.height },
        ...(profile.userAgent ? { userAgent: profile.userAgent } : {})
      })
      const page = await context.newPage()
      try {
        await page.goto('http://localhost:1234/dapp.html')

        await page.evaluate(() => {
          document.body.style.minHeight = '3000px'
          window.scrollTo(0, 600)
          beacon.openAlert({
            title: 'Network Error Occurred',
            body: 'The operation request could not be completed because the remote node returned an invalid parameter error.',
            data: '{"kind":"permanent","id":"proto.alpha.michelson_v1.bad_stack_item"}',
            buttons: [
              { text: 'Retry Request', actionCallback: async () => {} },
              { text: 'Reset Wallet', actionCallback: async () => {} }
            ]
          })
        })

        await page.waitForTimeout(400)

        const layout = await inspectAlertLayout(page)
        expect(layout.found).toBe(true)
        expect(layout.scrollY).toBeGreaterThanOrEqual(500)
        expect(layout.position).toBe('fixed')
        expect(layout.containerRect.top).toBeGreaterThanOrEqual(0)
        expect(layout.containerRect.left).toBeGreaterThanOrEqual(0)
        expect(layout.containerRect.right).toBeLessThanOrEqual(profile.width)
        expect(layout.containerRect.bottom).toBeLessThanOrEqual(profile.height)
        expect(layout.horizontalOverflowPx).toBeLessThanOrEqual(1)
        expect(layout.closeButtonVisible).toBe(true)
        expect(layout.closeButtonInBounds).toBe(true)
        expect(layout.closeButtonHitTestable).toBe(true)
        expect(layout.overflowingChildren).toEqual([])
      } finally {
        await context.close()
      }
    })

    test(`PairingAlert (top wallets and install/QR view) fits within ${profile.name} when scrolled`, async ({
      browser
    }) => {
      const context = await browser.newContext({
        viewport: { width: profile.width, height: profile.height },
        ...(profile.userAgent ? { userAgent: profile.userAgent } : {})
      })
      const page = await context.newPage()
      try {
        await page.goto('http://localhost:1234/dapp.html')

        await page.evaluate(() => {
          document.body.style.minHeight = '3000px'
          window.scrollTo(0, 600)
          beacon.openAlert({
            title: 'Choose your preferred wallet',
            featuredWallets: ['kukai'],
            body: '',
            pairingPayload: {
              p2pSyncCode: Promise.resolve('tezos://?type=tzip10&data=mock-p2p-payload'),
              postmessageSyncCode: Promise.resolve('mock-postmessage-payload'),
              walletConnectSyncCode: new Promise<string>((resolve) =>
                window.addEventListener(
                  'release-pairing',
                  () => resolve('wc:mock@2?relay-protocol=irn&symKey=deadbeef'),
                  { once: true }
                )
              ),
              networkType: beacon.NetworkType.SHADOWNET
            }
          })
        })

        const kukai = page.locator('.wallet-main').filter({ hasText: 'Kukai' })
        await kukai.click({ trial: true })

        // 1. Check initial TopWallets view
        const topWalletsLayout = await inspectAlertLayout(page)
        expect(topWalletsLayout.found).toBe(true)
        expect(topWalletsLayout.position).toBe('fixed')
        expect(topWalletsLayout.containerRect.top).toBeGreaterThanOrEqual(0)
        expect(topWalletsLayout.containerRect.left).toBeGreaterThanOrEqual(0)
        expect(topWalletsLayout.containerRect.right).toBeLessThanOrEqual(profile.width)
        expect(topWalletsLayout.containerRect.bottom).toBeLessThanOrEqual(profile.height)
        expect(topWalletsLayout.horizontalOverflowPx).toBeLessThanOrEqual(1)
        expect(topWalletsLayout.closeButtonVisible).toBe(true)
        expect(topWalletsLayout.closeButtonInBounds).toBe(true)
        expect(topWalletsLayout.closeButtonHitTestable).toBe(true)
        expect(topWalletsLayout.overflowingChildren).toEqual([])

        await kukai.click()
        await expect(page.getByRole('dialog')).toHaveAttribute('aria-busy', 'true')
        const loadingLayout = await inspectAlertLayout(page)
        expect(loadingLayout.overflowingChildren).toEqual([])

        // Check after QR / install cards finish rendering
        await page.evaluate(() => window.dispatchEvent(new Event('release-pairing')))
        await expect(page.getByRole('button', { name: 'Use Browser' })).toBeVisible()
        if (profile.userAgent) await page.locator('#qr-code-icon').click()
        const qr = page.locator('.qr-svg-wrapper svg')
        await expect(qr).toBeVisible()
        const { width, height } = await qr.evaluate((svg) => {
          const rect = svg.getBoundingClientRect()
          return { width: rect.width, height: rect.height }
        })
        expect(width).toBeGreaterThanOrEqual(160)
        expect(Math.abs(width - height)).toBeLessThan(1)
        const installLayout = await inspectAlertLayout(page)
        expect(installLayout.containerRect.top).toBeGreaterThanOrEqual(0)
        expect(installLayout.containerRect.left).toBeGreaterThanOrEqual(0)
        expect(installLayout.containerRect.right).toBeLessThanOrEqual(profile.width)
        expect(installLayout.containerRect.bottom).toBeLessThanOrEqual(profile.height)
        expect(installLayout.horizontalOverflowPx).toBeLessThanOrEqual(1)
        expect(installLayout.closeButtonVisible).toBe(true)
        expect(installLayout.closeButtonInBounds).toBe(true)
        expect(installLayout.closeButtonHitTestable).toBe(true)
        expect(installLayout.overflowingChildren).toEqual([])

        // 3. Also verify WCInitError fallback layout fits within the viewport
        await page.evaluate(() => {
          beacon.openAlert({
            title: 'Choose your preferred wallet',
            featuredWallets: ['kukai'],
            body: '',
            pairingPayload: {
              p2pSyncCode: Promise.resolve('tezos://?type=tzip10&data=mock-p2p-payload'),
              postmessageSyncCode: Promise.resolve('mock-postmessage-payload'),
              walletConnectSyncCode: Promise.resolve({
                ok: false as const,
                reason: 'relay-unreachable' as const
              }),
              networkType: beacon.NetworkType.SHADOWNET
            }
          })
        })
        await kukai.click()
        await expect(page.getByRole('heading', { name: 'A network error occurred.' })).toBeVisible()
        const errorInstallLayout = await inspectAlertLayout(page)
        expect(errorInstallLayout.containerRect.top).toBeGreaterThanOrEqual(0)
        expect(errorInstallLayout.containerRect.left).toBeGreaterThanOrEqual(0)
        expect(errorInstallLayout.containerRect.right).toBeLessThanOrEqual(profile.width)
        expect(errorInstallLayout.containerRect.bottom).toBeLessThanOrEqual(profile.height)
        expect(errorInstallLayout.horizontalOverflowPx).toBeLessThanOrEqual(1)
        expect(errorInstallLayout.closeButtonVisible).toBe(true)
        expect(errorInstallLayout.closeButtonInBounds).toBe(true)
        expect(errorInstallLayout.closeButtonHitTestable).toBe(true)
        expect(errorInstallLayout.overflowingChildren).toEqual([])
      } finally {
        await context.close()
      }
    })
  }

  test('rapid openToast transitions followed by closeToast() do not resurrect toast', async ({
    page
  }) => {
    await page.goto('http://localhost:1234/dapp.html')

    await page.evaluate(async () => {
      beacon.openToast({ body: 'Preparing Request...', state: 'prepare' })
      await new Promise((r) => setTimeout(r, 30))
      beacon.openToast({
        body: 'Request sent to {{wallet}}',
        state: 'loading',
        walletInfo: { name: 'Kukai' }
      })
      await new Promise((r) => setTimeout(r, 30))
      beacon.openToast({
        body: 'Awaiting confirmation in {{wallet}}',
        state: 'acknowledge',
        walletInfo: { name: 'Kukai' }
      })
      await new Promise((r) => setTimeout(r, 30))
      beacon.closeToast()
    })

    // Wait past the 500ms / 600ms stagger delays
    await page.waitForTimeout(800)

    const isToastPresent = await page.evaluate(() => {
      const host = document.querySelector('beacon-toast')
      return Boolean(host?.shadowRoot?.querySelector('.toast-wrapper-show, .toast-wrapper-hide'))
    })
    expect(isToastPresent).toBe(false)
  })
})
