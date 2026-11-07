'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { ESLint } = require('eslint')

const eslint = new ESLint({ cwd: path.resolve(__dirname, '../..') })
const legacyRule = 'prefer-arrow/prefer-arrow-functions'

test('legacy arrow suppression comments remain valid in existing source files', async () => {
  const reports = await eslint.lintFiles([
    'packages/beacon-utils/src/utils/keys.ts',
    'packages/beacon-utils/src/utils/crypto.ts',
    'packages/beacon-utils/src/utils/generate-uuid.ts',
    'packages/beacon-core/src/utils/assert-never.ts',
    'packages/beacon-core/src/managers/StorageManager.ts'
  ])

  assert.equal(reports.length, 5)
  for (const report of reports) {
    // Existing ordinary lint findings are outside this configuration migration.
    const configurationFindings = report.messages.filter(
      (message) => message.fatal || message.ruleId === null || message.ruleId === legacyRule
    )
    assert.deepEqual(configurationFindings, [], report.filePath)
  }
})
