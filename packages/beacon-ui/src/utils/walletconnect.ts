import { WalletConnectPairingResult } from '@ecadlabs/beacon-types'
import type { WalletConnectSyncCode } from '../ui/common'

// Replaces @walletconnect/utils parseUri(...).symKey usage to avoid pulling crypto shims into beacon-ui.
export const hasWalletConnectSymKey = (uri: string): boolean => {
  if (!uri.startsWith('wc:')) {
    return false
  }

  const queryStart = uri.indexOf('?')
  if (queryStart === -1) {
    return false
  }

  return Boolean(new URLSearchParams(uri.slice(queryStart + 1)).get('symKey'))
}

export const unwrapWalletConnectResult = (
  value: WalletConnectSyncCode
): WalletConnectPairingResult => {
  if (typeof value === 'string') {
    return value.length > 0 ? { ok: true, uri: value } : { ok: false, reason: 'relay-unreachable' }
  }

  return value
}
