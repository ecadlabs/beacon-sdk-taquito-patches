import { expect } from 'vitest'
import * as matchers from '@testing-library/jest-dom/matchers'

// The standalone matchers avoid jest-dom's incompatible Vitest Assertion augmentation.
expect.extend(matchers)

declare module 'vitest' {
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    T = unknown
  > extends matchers.TestingLibraryMatchers<T, R> {}
}
