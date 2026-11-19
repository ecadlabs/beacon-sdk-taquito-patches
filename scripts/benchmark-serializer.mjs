// Run from the repository root after building @ecadlabs/beacon-core.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { chromium, webkit } from '@playwright/test'
import webpack from 'webpack'

const require = createRequire(import.meta.url)
const directory = await mkdtemp(path.join(tmpdir(), 'beacon-serializer-'))
let browser
try {
  const compiler = webpack({
    mode: 'production',
    entry: require.resolve('../packages/beacon-core/dist/cjs/Serializer.js'),
    output: { path: directory, filename: 'serializer.js', library: 'beaconCodec' },
    plugins: [new webpack.ProvidePlugin({ Buffer: [require.resolve('buffer/'), 'Buffer'] })]
  })
  try {
    await new Promise((resolve, reject) =>
      compiler.run((error, stats) => {
        if (error || stats.hasErrors()) reject(error ?? new Error(stats.toString()))
        else resolve()
      })
    )
  } finally {
    await new Promise((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve()))
    )
  }

  const useWebKit = process.argv.includes('--webkit')
  browser = useWebKit ? await webkit.launch() : await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage()
  await page.addScriptTag({ path: path.join(directory, 'serializer.js') })
  console.log(useWebKit ? 'Headless WebKit' : 'Headless Chrome', browser.version())
  const measure = (kib) =>
    page.evaluate(async (size) => {
      const codec = new globalThis.beaconCodec.Serializer()
      const value = { string: 'x'.repeat(size * 1024) }
      const request = {
        type: 'operation_request',
        operationDetails: [{ kind: 'transaction', parameters: { entrypoint: 'default', value } }]
      }
      const start = performance.now()
      const wire = await codec.serialize(request)
      const encoded = performance.now()
      const decoded = await codec.deserialize(wire)
      const end = performance.now()
      if (JSON.stringify(request) !== JSON.stringify(decoded)) throw new Error('Round trip failed')
      return {
        bytes: JSON.stringify(request).length,
        encodeMs: encoded - start,
        decodeMs: end - encoded
      }
    }, kib)
  for (let i = 0; i < 5; i++) await measure(1)
  for (const kib of [1, 8, 32, 64, 128]) console.log(await measure(kib))
} finally {
  await browser?.close()
  await rm(directory, { recursive: true, force: true })
}
