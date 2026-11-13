import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const source = new URL(
  '../packages/beacon-wallet/src/transports/WalletWalletConnectTransport.ts',
  import.meta.url
)
const original = readFileSync(source, 'utf8')
const run = (pattern) => {
  const args = [
    'test',
    '--workspace',
    '@ecadlabs/beacon-wallet',
    '--',
    'WalletWalletConnectTransport.test.ts'
  ]
  if (pattern) args.push('-t', pattern)
  const result = spawnSync('npm', args, { stdio: 'inherit', cwd: new URL('..', import.meta.url) })
  if (result.error || result.status === null)
    throw result.error ?? new Error('Test process did not exit normally')
  return result.status
}
const mutations = [
  {
    name: 'outbound disconnect retires requests only after the relay responds',
    before: '          this.clearTopic(topic)\n          await signClient.disconnect({ topic, reason: WC_USER_DISCONNECTED })',
    after: '          await signClient.disconnect({ topic, reason: WC_USER_DISCONNECTED })\n          this.clearTopic(topic)',
    test: 'bounds request ownership'
  },
  {
    name: 'stale peer admission starts another client after cleanup',
    before: '      newPeer,\n      () => generation === this.generation,',
    after: '      newPeer,\n      () => true,',
    test: 'does not initialize a client'
  },
  {
    name: 'late initialization attaches listeners after cleanup',
    before:
      '      const signClient = await this.ensureSignClient()\n      if (generation !== this.generation || this.signClient !== signClient) {\n        return\n      }\n      if (this.relayerClosed) {',
    after:
      '      const signClient = await this.ensureSignClient()\n      if (this.relayerClosed) {',
    test: 'bounds initialization ownership'
  },
  {
    name: 'session close retains request correlation',
    before: '    this.clearTopic(topic)\n    const generation = this.generation',
    after: '    const generation = this.generation',
    test: 'bounds request ownership'
  },
  {
    name: 'failed delivery loses its correlation',
    before: '    const existing = this.responsesInFlight.get(pending)',
    after:
      '    this.pendingByBeaconId.delete(deserialized.id)\n    const existing = this.responsesInFlight.get(pending)',
    test: 'failed proposal rejection'
  },
  {
    name: 'acknowledgement failure approves the proposal again',
    before:
      "    if (pending.approval.kind === 'approved') {\n      return pending.approval.completion\n    }",
    after: '',
    test: 'retains the acknowledgement failure'
  }
]

if (run() !== 0) throw new Error('Unmodified ownership checks failed')
for (const mutation of mutations) {
  const matches = original.split(mutation.before).length - 1
  if (matches !== 1)
    throw new Error(`Code correspondence changed: ${mutation.name} (${matches} matches)`)
  try {
    writeFileSync(source, original.replace(mutation.before, mutation.after))
    if (run(mutation.test) === 0) throw new Error(`Mutation survived: ${mutation.name}`)
    console.info(`Caught mutation: ${mutation.name}`)
  } finally {
    writeFileSync(source, original)
  }
}
if (run() !== 0) throw new Error('Restored ownership checks failed')
console.info('WalletConnect wallet ownership checks passed; all six mutations were caught.')
