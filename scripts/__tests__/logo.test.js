'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createDataUri } = require('../helpers/logo')

test('createDataUri returns an SVG data URI', () => {
  const buffer = Buffer.from('<svg></svg>', 'utf8')

  assert.equal(createDataUri(buffer, 'svg'), `data:image/svg+xml;base64,${buffer.toString('base64')}`)
})

test('createDataUri returns a PNG data URI', () => {
  const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47])

  assert.equal(createDataUri(buffer, '.png'), `data:image/png;base64,${buffer.toString('base64')}`)
})
