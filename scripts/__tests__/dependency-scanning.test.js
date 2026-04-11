'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createDependencyScanningReport } = require('../helpers/dependency-scanning')

test('createDependencyScanningReport converts npm audit v2 vulnerabilities into report entries', () => {
  const audit = {
    vulnerabilities: {
      mocha: {
        name: 'mocha',
        severity: 'high',
        via: [
          {
            source: 1113686,
            name: 'serialize-javascript',
            title: 'Serialize JavaScript is Vulnerable to RCE via RegExp.flags and Date.prototype.toISOString()',
            url: 'https://github.com/advisories/GHSA-5c6j-r48x-rmvq',
            severity: 'high',
            cwe: ['CWE-96']
          }
        ],
        fixAvailable: {
          name: 'mocha',
          version: '11.7.6'
        }
      },
      minimatch: {
        name: 'minimatch',
        severity: 'high',
        via: [
          {
            source: 1113552,
            name: 'minimatch',
            title:
              'minimatch ReDoS: nested *() extglobs generate catastrophically backtracking regular expressions',
            url: 'https://github.com/advisories/GHSA-23c5-xmqv-rm74',
            severity: 'high',
            cwe: ['CWE-1333']
          },
          '@typescript-eslint/typescript-estree'
        ],
        fixAvailable: true
      }
    }
  }

  assert.deepEqual(createDependencyScanningReport(audit), [
    {
      message:
        'Serialize JavaScript is Vulnerable to RCE via RegExp.flags and Date.prototype.toISOString()\n\nAffected package: mocha',
      cve: null,
      cwe: ['CWE-96'],
      solution: 'Upgrade to mocha@11.7.6',
      url: 'https://github.com/advisories/GHSA-5c6j-r48x-rmvq',
      priority: 'High'
    },
    {
      message:
        'minimatch ReDoS: nested *() extglobs generate catastrophically backtracking regular expressions\n\nAffected package: minimatch',
      cve: null,
      cwe: ['CWE-1333'],
      solution: 'Upgrade to a patched version',
      url: 'https://github.com/advisories/GHSA-23c5-xmqv-rm74',
      priority: 'High'
    }
  ])
})
