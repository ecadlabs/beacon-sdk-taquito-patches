'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  getPrereleaseTag,
  hasExplicitTagArg,
  resolvePublishTag
} = require('../helpers/publish-workspaces')

test('getPrereleaseTag returns the prerelease channel for ecad versions', () => {
  assert.equal(getPrereleaseTag('4.8.1-ecad.5'), 'ecad')
  assert.equal(getPrereleaseTag('4.8.2-beta.0'), 'beta')
  assert.equal(getPrereleaseTag('4.8.1'), undefined)
})

test('hasExplicitTagArg detects npm publish tag overrides', () => {
  assert.equal(hasExplicitTagArg(['--tag', 'latest']), true)
  assert.equal(hasExplicitTagArg(['--tag=latest']), true)
  assert.equal(hasExplicitTagArg(['--otp', '123456']), false)
})

test('resolvePublishTag defaults prereleases to their channel', () => {
  assert.equal(
    resolvePublishTag({
      version: '4.8.1-ecad.5',
      extraArgs: [],
      env: {}
    }),
    'ecad'
  )
})

test('resolvePublishTag honors release workflow latest override', () => {
  assert.equal(
    resolvePublishTag({
      version: '4.8.1-ecad.5',
      extraArgs: ['--tag', 'latest'],
      env: {}
    }),
    undefined
  )

  assert.equal(
    resolvePublishTag({
      version: '4.8.1-ecad.5',
      extraArgs: [],
      env: { NPM_DIST_TAG: 'latest' }
    }),
    'latest'
  )
})
