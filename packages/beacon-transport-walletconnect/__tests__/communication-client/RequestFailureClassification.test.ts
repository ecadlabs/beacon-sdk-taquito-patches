import fs from 'node:fs'
import path from 'node:path'
import {
  classifyRequestFailure,
  SIGN_CLIENT_REQUEST_EXPIRED_MESSAGE,
  SIGN_CLIENT_USER_DISCONNECTED_CODE
} from '../../src/communication-client/request-failure'

// When signClient.request() rejects, the adapter has to tell a wallet answer from a failure
// that sign-client or the adapter made itself. Only a wallet answer may be reported as a late
// response, and only sign-client's request expiry means the wallet never answered.

describe('classifyRequestFailure', () => {
  it.each([
    ['a user rejection', { code: 5000, message: 'User rejected.' }],
    ['a wallet error with data', { code: -32000, message: 'Invalid operation', data: 'x' }]
  ])('treats %s (a JSON-RPC error object) as a wallet answer', (_case, error) => {
    expect(classifyRequestFailure(error)).toBe('wallet')
  })

  it('treats sign-client request expiry as expired', () => {
    expect(classifyRequestFailure(new Error(SIGN_CLIENT_REQUEST_EXPIRED_MESSAGE))).toBe('expired')
  })

  it.each([
    [
      'the USER_DISCONNECTED cleanup after a session delete',
      { code: 6000, message: 'User disconnected.' }
    ],
    ['a publish failure', new Error('Failed to publish payload')],
    ['a validation failure', new Error('Missing or invalid. request() method: tezos_send')],
    // An Error carrying JSON-RPC fields was still made locally.
    ['an Error with a code', Object.assign(new Error('User rejected.'), { code: 5000 })],
    ['a string', 'Request expired. Please try again.'],
    ['undefined', undefined],
    ['null', null],
    ['an object with a string code', { code: '5000', message: 'User rejected.' }],
    ['an object without a message', { code: 5000 }]
  ])('treats %s as a local failure', (_case, error) => {
    expect(classifyRequestFailure(error)).toBe('local')
  })
})

// The classification relies on how @walletconnect/sign-client 2.18.0 behaves. The package is
// pinned for Kukai iOS; if the pin moves, these fail and the classifier must be rechecked.
describe('sign-client 2.18.0 request failures', () => {
  const root = path.join(__dirname, '..', '..', '..', '..', 'node_modules', '@walletconnect')
  const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

  it('is the pinned version', () => {
    expect(JSON.parse(read('sign-client/package.json')).version).toBe('2.18.0')
    expect(JSON.parse(read('utils/package.json')).version).toBe('2.18.0')
  })

  it('rejects request() locally with the expiry message after the five minute request TTL', () => {
    const signClient = read('sign-client/dist/index.cjs.js')
    expect(signClient).toMatch(/wc_sessionRequest:\{req:\{ttl:\w+\.FIVE_MINUTES/)
    expect(signClient).toContain(`expiry:n=f.wc_sessionRequest.req.ttl}=e`)
    expect(signClient).toContain(`createDelayedPromise(n,"${SIGN_CLIENT_REQUEST_EXPIRED_MESSAGE}")`)
    // createDelayedPromise rejects with an Error built from that message.
    expect(read('utils/dist/index.cjs.js')).toMatch(
      /s=setTimeout\(\(\)=>\{const a=new Error\(t\);i=Promise\.reject\(a\),u\(a\)\},n\)/
    )
  })

  it('rejects a wallet error with the JSON-RPC error object, not an Error', () => {
    expect(read('sign-client/dist/index.cjs.js')).toContain(
      'E.isJsonRpcError(t)&&this.events.emit(i.engineEvent("session_request",s),{error:t.error})'
    )
  })

  it('rejects pending requests with USER_DISCONNECTED when the wallet deletes the session', () => {
    expect(read('sign-client/dist/index.cjs.js')).toContain(
      'cleanupPendingSentRequestsForTopic({topic:e,error:i.getSdkError("USER_DISCONNECTED")})'
    )
    expect(read('utils/dist/index.cjs.js')).toContain(
      'USER_DISCONNECTED:{message:"User disconnected.",code:6e3}'
    )
    expect(SIGN_CLIENT_USER_DISCONNECTED_CODE).toBe(6000)
  })
})
