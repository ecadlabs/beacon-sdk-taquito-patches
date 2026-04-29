import { Logger } from '@ecadlabs/beacon-core'
// Use browser-safe synchronous SVG internals; the public async entrypoint can load Node renderers.
import { create } from 'qrcode/lib/core/qrcode'
import { render } from 'qrcode/lib/renderer/svg-tag'

const logger = new Logger('QR')

/**
 * Convert data to a QR code
 *
 * @param payload The data to be encoded as a QR code
 * @param height Fallback square size when width is not provided
 * @param width Square size of the generated QR SVG
 */
export const getQrData = (payload: string, height?: number, width?: number): string => {
  if (payload.length > 500) {
    logger.warn(
      'getQrData',
      'The size of the payload in the QR code is quite long and some devices might not be able to scan it anymore. To reduce the QR size, try using a shorter "name", "appUrl" and "iconUrl"'
    )
  }
  try {
    return render(create(payload, { errorCorrectionLevel: 'L' }), {
      width: width ?? height,
      color: {
        dark: '#000000ff',
        light: '#ffffffff'
      }
    })
  } catch (qrError) {
    console.error('error', qrError)
    throw qrError
  }
}
