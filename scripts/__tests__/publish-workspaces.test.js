'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  getPrereleaseTag,
  hasExplicitTagArg,
  resolvePublishCommand,
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

test('resolvePublishCommand reuses npm_execpath when npm launched the script', () => {
  assert.deepEqual(
    resolvePublishCommand({
      publishArgs: ['publish', '--access', 'public', '--tag', 'latest'],
      env: {
        npm_execpath: '/tmp/beacon-sdk-npm11/node_modules/npm/bin/npm-cli.js'
      },
      nodeExecPath: '/usr/bin/node'
    }),
    {
      command: '/usr/bin/node',
      args: [
        '/tmp/beacon-sdk-npm11/node_modules/npm/bin/npm-cli.js',
        'publish',
        '--access',
        'public',
        '--tag',
        'latest'
      ]
    }
  )
})

test('resolvePublishCommand falls back to npm on path outside npm-launched processes', () => {
  assert.deepEqual(
    resolvePublishCommand({
      publishArgs: ['publish', '--access', 'public'],
      env: {},
      nodeExecPath: '/usr/bin/node'
    }),
    {
      command: 'npm',
      args: ['publish', '--access', 'public']
    }
  )
})
