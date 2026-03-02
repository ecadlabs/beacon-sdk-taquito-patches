import { ColorMode } from '@ecadlabs/beacon-types'

let colorMode: ColorMode = ColorMode.LIGHT

export const setColorMode = (mode: ColorMode): void => {
  colorMode = mode
}

export const getColorMode = (): ColorMode => colorMode
