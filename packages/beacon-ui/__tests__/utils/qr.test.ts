import { getQrData } from '../../src/utils/qr'
import { TextEncoder } from 'util'

Object.defineProperty(globalThis, 'TextEncoder', {
  configurable: true,
  value: TextEncoder
})

describe('getQrData', () => {
  it('returns SVG QR markup synchronously', () => {
    const svg = getQrData('tezos://example', 160, 160)

    expect(svg).toContain('<svg')
    expect(svg).toContain('viewBox=')
    expect(svg).toContain('width="160"')
  })

  it('uses width as the square SVG size when height is also provided', () => {
    const svg = getQrData('tezos://example', 100, 200)

    expect(svg).toContain('width="200"')
  })
})
