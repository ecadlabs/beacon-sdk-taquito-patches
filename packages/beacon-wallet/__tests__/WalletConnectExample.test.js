const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

it('serves the newly advertised wallet account while session acknowledgement is pending', async () => {
  const html = readFileSync(path.resolve(__dirname, '../../../examples/wallet-wc.html'), 'utf8')
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .join('\n')
    .replace("const projectId = 'YOUR_PROJECT_ID'", "const projectId = 'test-project-id'")
  const handlers = new Map()
  const elements = new Map()
  let initialized
  let updateEntered
  let releaseAcknowledgement
  let advertised
  let response
  const ready = new Promise((resolve) => {
    initialized = resolve
  })
  const updating = new Promise((resolve) => {
    updateEntered = resolve
  })
  const acknowledgement = new Promise((resolve) => {
    releaseAcknowledgement = resolve
  })
  const session = {
    topic: 'example-session',
    peer: { metadata: { name: 'Example dApp' } },
    namespaces: { tezos: { accounts: ['tezos:ghostnet:tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb'] } }
  }
  const signClient = {
    session: { getAll: () => [session] },
    on: (event, handler) => {
      handlers.set(event, handler)
      if (event === 'session_request') initialized()
    },
    update: async ({ namespaces }) => {
      advertised = JSON.parse(JSON.stringify(namespaces))
      updateEntered()
      return { acknowledged: () => acknowledgement }
    },
    respond: async (packet) => {
      response = JSON.parse(JSON.stringify(packet.response))
    }
  }
  const context = vm.createContext({
    window: {
      location: { origin: 'http://localhost:1234' },
      SignClient: { init: async () => signClient },
      addEventListener: (event, handler) => handlers.set(`window:${event}`, handler)
    },
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) {
          elements.set(id, {
            addEventListener: (event, handler) => handlers.set(`${id}:${event}`, handler)
          })
        }
        return elements.get(id)
      }
    },
    setTimeout: (handler) => handler(),
    console,
    alert: (message) => {
      throw new Error(message)
    }
  })
  vm.runInContext(script, context, { filename: 'wallet-wc.html' })
  handlers.get('window:load')()
  await ready
  const completingUpdate = handlers.get('update:click')()
  try {
    await updating
    assert.equal(
      advertised.tezos.accounts[0],
      'tezos:ghostnet:tz1TwNWHfczra9ubmB9qbqw49EJN3fVcwsVo'
    )
    await handlers.get('session_request')({
      topic: session.topic,
      id: 1,
      params: { request: { method: 'tezos_getAccounts' } }
    })
    assert.deepEqual(response.result, [
      {
        algo: 'ed25519',
        address: 'tz1TwNWHfczra9ubmB9qbqw49EJN3fVcwsVo',
        pubkey: 'edpku28rWpLN6CksuPZMwE3Ew2AdVeRyVoddJhkUEqksrPybgvEWRn'
      }
    ])
  } finally {
    releaseAcknowledgement()
    await completingUpdate
  }
})
