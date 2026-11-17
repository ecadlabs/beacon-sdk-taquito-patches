import { getBeaconMessages } from '@ecadlabs/beacon-types'
import './styles.css'

const Loader = () => {
  const { aria } = getBeaconMessages()

  return <div className="loader" role="status" aria-label={aria.loading}></div>
}

export { Loader }
