type PairingState =
  | { readonly tag: 'CollectingCandidates' }
  | { readonly tag: 'CommittingWinner'; readonly winner: symbol }
  | { readonly tag: 'Finished' | 'Cancelled' }

type PairingInput =
  { readonly tag: 'Reserve' | 'Complete'; readonly winner: symbol } | { readonly tag: 'Cancel' }

const transitionPairing = (state: PairingState, input: PairingInput): PairingState | undefined => {
  switch (input.tag) {
    case 'Reserve':
      return state.tag === 'CollectingCandidates'
        ? { tag: 'CommittingWinner', winner: input.winner }
        : undefined
    case 'Complete':
      return state.tag === 'CommittingWinner' && state.winner === input.winner
        ? { tag: 'Finished' }
        : undefined
    case 'Cancel':
      return state.tag === 'CollectingCandidates' || state.tag === 'CommittingWinner'
        ? { tag: 'Cancelled' }
        : undefined
    default:
      return undefined
  }
}

/** A reserved winner remains cancellable until its publication callbacks finish. */
export class PairingAttempt {
  private state: PairingState = { tag: 'CollectingCandidates' }

  public get collecting(): boolean {
    return this.state.tag === 'CollectingCandidates'
  }

  public reserve(): symbol | undefined {
    const winner = Symbol('pairing winner')

    return this.advance({ tag: 'Reserve', winner }) ? winner : undefined
  }

  public owns(winner: symbol): boolean {
    return this.state.tag === 'CommittingWinner' && this.state.winner === winner
  }

  public complete(winner: symbol): boolean {
    return this.advance({ tag: 'Complete', winner })
  }

  public cancel(): boolean {
    return this.advance({ tag: 'Cancel' })
  }

  private advance(input: PairingInput): boolean {
    const next = transitionPairing(this.state, input)
    if (!next) {
      return false
    }
    this.state = next

    return true
  }
}
