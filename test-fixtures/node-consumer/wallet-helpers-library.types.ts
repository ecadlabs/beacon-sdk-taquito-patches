import type { OperationRequestInput, WalletPartialTezosOperation } from '@ecadlabs/beacon-types'
import { isPartialTezosOperation } from '@ecadlabs/beacon-utils/wallet'

export const acceptedOperations = (rows: unknown[]) => rows.filter(isPartialTezosOperation)
export const acceptedOperation = (value: unknown) => {
  if (isPartialTezosOperation(value)) return value
  return undefined
}

export const existingInputOperation = (request: OperationRequestInput) =>
  request.operationDetails[0]

export const acceptedOperationRequest = (
  value: OperationRequestInput['operationDetails'][number] | string
) => {
  if (isPartialTezosOperation(value)) {
    const operation: WalletPartialTezosOperation = value
    const operationRequest: Pick<OperationRequestInput, 'operationDetails'> = {
      operationDetails: [value]
    }
    return { operation, operationRequest }
  }
  return value
}
