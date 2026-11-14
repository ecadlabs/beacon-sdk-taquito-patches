import { vi } from 'vitest'
import { StrictMode } from 'react'
import { InternalLogger, setLogger } from '@ecadlabs/beacon-core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useWallets } from '../../src/ui/alert/hooks/useWallets'
import { getAvailableExtensions } from '../../src/utils/extensions'
import { OSLink } from '../../src/utils/wallets'

vi.mock('../../src/utils/extensions', () => ({
  getAvailableExtensions: vi.fn()
}))

const deferred = <T,>() => {
  let resolve: (value: T) => void
  let reject: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return {
    promise,
    resolve: (value: T) => resolve(value),
    reject: (reason?: unknown) => reject(reason)
  }
}

describe('discovered extension wallet links', () => {
  it.each([
    {
      name: 'a string link',
      metadata: { link: 'https://extension.example' },
      expected: 'https://extension.example'
    },
    { name: 'no link', metadata: {}, expected: '' },
    {
      name: 'a malformed link',
      metadata: { link: { url: 'https://extension.example' } },
      expected: ''
    }
  ])('maps $name to the extension wallet link', async ({ metadata, expected }) => {
    const extension = new Proxy(
      { id: 'custom-extension-issue35', name: 'Custom Wallet', ...metadata },
      {
        has() {
          throw new Error('Extension metadata does not support property checks')
        }
      }
    )
    vi.mocked(getAvailableExtensions).mockResolvedValue([extension])

    const { result } = renderHook(() => useWallets())

    await waitFor(() => {
      expect(result.current.wallets.get(extension.id)?.links[OSLink.EXTENSION]).toBe(expected)
    })
  })
})

it('refreshes wallets when discovery reuses its mutated cached array', async () => {
  const initialExtension = { id: 'initial-extension', name: 'Initial Wallet' }
  const addedExtension = { id: 'added-extension', name: 'Added Wallet' }
  const extensions = [initialExtension]
  vi.mocked(getAvailableExtensions).mockResolvedValue(extensions)
  const { result } = renderHook(() => useWallets())

  await waitFor(() => expect(result.current.wallets.has(initialExtension.id)).toBe(true))
  extensions.push(addedExtension)

  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: 'extensionsUpdated' }))
  })

  expect(result.current.availableExtensions).toEqual([initialExtension, addedExtension])
  expect(result.current.wallets.has(addedExtension.id)).toBe(true)
})

describe('extension discovery ownership', () => {
  const diagnostic = vi.fn()

  beforeEach(() => {
    const logger = new InternalLogger()
    logger.diagnostic = diagnostic
    setLogger(logger)
  })

  afterEach(() => setLogger(new InternalLogger()))

  it.each(['initial', 'message'])(
    'reports a rejected %s discovery without losing wallets',
    async (trigger) => {
      const failure = new Error('Extension discovery failed')
      const extension = { id: 'accepted-extension', name: 'Accepted Wallet' }
      if (trigger === 'initial') {
        vi.mocked(getAvailableExtensions).mockRejectedValueOnce(failure)
      } else {
        vi.mocked(getAvailableExtensions).mockResolvedValueOnce([extension])
      }
      const { result } = renderHook(() => useWallets())

      if (trigger === 'message') {
        await waitFor(() => expect(result.current.wallets.has(extension.id)).toBe(true))
        vi.mocked(getAvailableExtensions).mockRejectedValueOnce(failure)
        await act(async () => {
          window.dispatchEvent(new MessageEvent('message', { data: 'extensionsUpdated' }))
        })
      }

      await waitFor(() =>
        expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
          level: 'error',
          service: 'BeaconUIWallets',
          method: 'getAvailableExtensions',
          args: [failure]
        })
      )
      expect(result.current.availableExtensions).toEqual(trigger === 'initial' ? [] : [extension])
      expect(result.current.wallets.size).toBeGreaterThan(0)
    }
  )

  it.each(['success', 'failure'])(
    'keeps the latest-started refresh authoritative after its %s',
    async (outcome) => {
      const accepted = { id: 'accepted-extension', name: 'Accepted Wallet' }
      const obsolete = { id: 'obsolete-extension', name: 'Obsolete Wallet' }
      const newest = { id: 'newest-extension', name: 'Newest Wallet' }
      const olderRequest =
        deferred<Awaited<ReturnType<typeof getAvailableExtensions>>>()
      const newestRequest =
        deferred<Awaited<ReturnType<typeof getAvailableExtensions>>>()
      vi.mocked(getAvailableExtensions)
        .mockResolvedValueOnce([accepted])
        .mockReturnValueOnce(olderRequest.promise)
        .mockReturnValueOnce(newestRequest.promise)
      const { result } = renderHook(() => useWallets())
      await waitFor(() => expect(result.current.wallets.has(accepted.id)).toBe(true))

      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data: 'extensionsUpdated' }))
        window.dispatchEvent(new MessageEvent('message', { data: 'extensionsUpdated' }))
        if (outcome === 'success') {
          newestRequest.resolve([newest])
        } else {
          newestRequest.reject(new Error('Newest discovery failed'))
        }
      })
      await act(async () => olderRequest.resolve([obsolete]))

      expect(result.current.availableExtensions).toEqual(
        outcome === 'success' ? [newest] : [accepted]
      )
      expect(result.current.wallets.has(obsolete.id)).toBe(false)
      expect(diagnostic).toHaveBeenCalledTimes(outcome === 'success' ? 0 : 1)
    }
  )
})

it('ignores discovery from a disposed effect after StrictMode replay', async () => {
  const disposed = { id: 'disposed-extension', name: 'Disposed Wallet' }
  const current = { id: 'current-extension', name: 'Current Wallet' }
  const disposedRequest =
    deferred<Awaited<ReturnType<typeof getAvailableExtensions>>>()
  vi.mocked(getAvailableExtensions)
    .mockReturnValueOnce(disposedRequest.promise)
    .mockResolvedValueOnce([current])
  const { result } = renderHook(() => useWallets(), { wrapper: StrictMode })
  await waitFor(() => expect(result.current.wallets.has(current.id)).toBe(true))

  await act(async () => disposedRequest.resolve([disposed]))

  expect(result.current.availableExtensions).toEqual([current])
  expect(result.current.wallets.has(disposed.id)).toBe(false)
})
