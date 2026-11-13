# Logging and required diagnostics

The SDK has two logging policies in `@ecadlabs/beacon-core`.

`Logger` provides optional debug output. Its default levelled output is disabled until `setDebugEnabled(true)` is called or the SDK debug flag is present. Existing timing behavior is unchanged.

`reportDiagnostic` reports a warning or failure that must remain visible with the default logger, even when debugging is disabled. Use it for detached initialization or cleanup failures and integration warnings that callers otherwise cannot observe.

```ts
import { reportDiagnostic } from '@ecadlabs/beacon-core'

try {
  await initialize()
} catch (error: unknown) {
  reportDiagnostic({
    level: 'error',
    service: 'Application',
    method: 'initialize',
    args: [error]
  })
}
```

The default adapter preserves the supplied `log`, `warn` or `error` severity and original arguments. It adds no grouping, timestamp or payload transformation to required diagnostics.

`setLogger(custom)` controls both policies. A custom logger may implement the optional `diagnostic(record)` method to receive the full `LoggerDiagnostic` record. Older custom loggers continue receiving diagnostics through their corresponding severity method, using the existing runtime argument tuple: service name, method name, arguments array. Ordinary logger forwarding retains that same convention.

The reporter looks up the current sink for each call, so later `setLogger` replacements apply immediately. The configured sink controls its own filtering. If a sink throws or returns a rejected promise, the SDK falls back to the native console with the original diagnostic arguments. A structured sink can return `Promise<void>`; promise results from legacy severity methods are also observed. `reportDiagnostic` returns immediately and does not delay the caller while an asynchronous sink completes. Ordinary logger methods retain their existing behavior.

Console access belongs in the logger adapter. Application code should choose the appropriate logging policy instead of bypassing it or enabling all debug output to expose one required warning.
