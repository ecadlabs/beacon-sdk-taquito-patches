import { ColorMode } from '@ecadlabs/beacon-types'

interface BeaconColorModeSharedState {
  colorMode: ColorMode
  listeners: Set<() => void>
}

const COLOR_MODE_GLOBAL_SYMBOL = Symbol.for('@ecadlabs/beacon-sdk/color-mode-state')

const getSharedColorModeState = (): BeaconColorModeSharedState => {
  const host = globalThis as Record<symbol, BeaconColorModeSharedState | undefined>
  if (!host[COLOR_MODE_GLOBAL_SYMBOL]) {
    host[COLOR_MODE_GLOBAL_SYMBOL] = {
      colorMode: ColorMode.LIGHT,
      listeners: new Set()
    }
  }

  return host[COLOR_MODE_GLOBAL_SYMBOL]
}

export const subscribeColorMode = (listener: () => void): (() => void) => {
  const state = getSharedColorModeState()
  state.listeners.add(listener)

  return () => {
    state.listeners.delete(listener)
  }
}

export const setColorMode = (mode: ColorMode): void => {
  const state = getSharedColorModeState()
  if (state.colorMode === mode) {
    return
  }
  state.colorMode = mode
  for (const listener of Array.from(state.listeners)) {
    listener()
  }
}

export const getColorMode = (): ColorMode => getSharedColorModeState().colorMode
