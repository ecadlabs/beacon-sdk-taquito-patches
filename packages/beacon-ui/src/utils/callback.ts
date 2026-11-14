import { reportDiagnostic } from '@ecadlabs/beacon-core'

export const runUICallback = (callback: () => unknown, service: string, method: string) => {
  const reportFailure = (error: unknown) =>
    reportDiagnostic({
      level: 'error',
      service,
      method,
      args: [error]
    })
  try {
    const completion: unknown = callback()
    Promise.resolve(completion).catch(reportFailure)
  } catch (error) {
    reportFailure(error)
  }
}
