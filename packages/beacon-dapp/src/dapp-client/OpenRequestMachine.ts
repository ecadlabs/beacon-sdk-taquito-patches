export type RequestDeadline = 'Disabled' | 'Armed' | 'Acknowledged'

export type OpenRequestState =
  | {
      readonly tag: 'Dispatched' | 'ForwardedToLeader' | 'Acknowledged' | 'ResponsePreparing'
      readonly deadline: RequestDeadline
    }
  | { readonly tag: 'Resolved' | 'Rejected' | 'TimedOut' | 'Aborted' }

export type OpenRequestInput =
  | 'ArmDeadline'
  | 'Acknowledge'
  | 'BeginPreparation'
  | 'Resolve'
  | 'Prepared'
  | 'Reject'
  | 'PreparationFailed'
  | 'Deadline'
  | 'Abort'

export function transitionRequest(
  state: OpenRequestState,
  input: OpenRequestInput
): OpenRequestState | undefined {
  if (!('deadline' in state)) {
    return undefined
  }

  switch (input) {
    case 'ArmDeadline':
      return state.deadline === 'Disabled' ? { ...state, deadline: 'Armed' } : undefined
    case 'Acknowledge':
      return state.deadline === 'Acknowledged'
        ? undefined
        : {
            tag: state.tag === 'ResponsePreparing' ? 'ResponsePreparing' : 'Acknowledged',
            deadline: 'Acknowledged'
          }
    case 'BeginPreparation':
      return state.tag === 'ResponsePreparing'
        ? undefined
        : { tag: 'ResponsePreparing', deadline: state.deadline }
    case 'Resolve':
      return state.tag === 'ResponsePreparing' ? undefined : { tag: 'Resolved' }
    case 'Prepared':
      return state.tag === 'ResponsePreparing' ? { tag: 'Resolved' } : undefined
    case 'Reject':
      return state.tag === 'ResponsePreparing' ? undefined : { tag: 'Rejected' }
    case 'PreparationFailed':
      return state.tag === 'ResponsePreparing' ? { tag: 'Rejected' } : undefined
    case 'Deadline':
      return state.deadline === 'Armed' ? { tag: 'TimedOut' } : undefined
    case 'Abort':
      return { tag: 'Aborted' }
    default:
      return undefined
  }
}
