import { StorageKey } from '@ecadlabs/beacon-types'
import { LocalStorage } from '../../src/storage/LocalStorage'
import { StorageValidator } from '../../src/storage/StorageValidator'

describe('StorageValidator', () => {
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('accepts missing optional storage values', async () => {
    await expect(new StorageValidator(new LocalStorage()).validate()).resolves.toBe(true)
  })

  it.each(['temple', '', null, false, 0])(
    'checks wallet key presence without tightening its value policy: %p',
    async (key) => {
      localStorage.setItem(StorageKey.LAST_SELECTED_WALLET, JSON.stringify({ key }))

      await expect(new StorageValidator(new LocalStorage()).validate()).resolves.toBe(true)
    }
  )

  it('rejects a wallet record without its own key', async () => {
    localStorage.setItem(StorageKey.LAST_SELECTED_WALLET, JSON.stringify({ name: 'Temple' }))

    await expect(new StorageValidator(new LocalStorage()).validate()).resolves.toBe(false)
  })

  it.each([null, 'not a method'])(
    'accepts an own wallet key when stored data shadows hasOwnProperty with %p',
    async (hasOwnProperty) => {
      localStorage.setItem(
        StorageKey.LAST_SELECTED_WALLET,
        JSON.stringify({ key: 'temple', hasOwnProperty })
      )

      await expect(new StorageValidator(new LocalStorage()).validate()).resolves.toBe(true)
    }
  )

  it.each([null, 'not a method'])(
    'rejects a missing wallet key when stored data shadows hasOwnProperty with %p',
    async (hasOwnProperty) => {
      localStorage.setItem(
        StorageKey.LAST_SELECTED_WALLET,
        JSON.stringify({ name: 'Temple', hasOwnProperty })
      )

      await expect(new StorageValidator(new LocalStorage()).validate()).resolves.toBe(false)
    }
  )

  it('propagates storage read errors', async () => {
    const storage = new LocalStorage()
    const error = new Error('Storage unavailable')
    vi.spyOn(storage, 'get').mockRejectedValue(error)

    await expect(new StorageValidator(storage).validate()).rejects.toBe(error)
  })
})
