declare module 'qrcode/lib/core/qrcode' {
  export interface QRCodeData {
    modules: {
      size: number
      data: boolean[]
    }
  }

  export function create(
    data: string,
    options?: {
      errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
      version?: number
      maskPattern?: number
      toSJISFunc?: (codePoint: string) => number
    }
  ): QRCodeData
}

declare module 'qrcode/lib/renderer/svg-tag' {
  import { QRCodeData } from 'qrcode/lib/core/qrcode'

  export function render(
    qrData: QRCodeData,
    options?: {
      width?: number
      margin?: number
      color?: {
        dark?: string
        light?: string
      }
    }
  ): string
}
