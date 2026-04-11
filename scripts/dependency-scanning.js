'use strict'

const fs = require('fs')
const { execFileSync } = require('child_process')

const { createDependencyScanningReport } = require('./helpers/dependency-scanning')

function runAudit() {
  try {
    const stdout = execFileSync('npm', ['audit', '--json'], {
      encoding: 'utf8'
    })

    return {
      audit: JSON.parse(stdout),
      exitCode: 0
    }
  } catch (error) {
    const stdout = error.stdout ? error.stdout.toString() : ''

    if (!stdout.trim()) {
      throw error
    }

    return {
      audit: JSON.parse(stdout),
      exitCode: error.status || 1
    }
  }
}

const { audit, exitCode } = runAudit()
const report = createDependencyScanningReport(audit)

fs.writeFileSync('audit.json', `${JSON.stringify(audit, null, 2)}\n`, 'utf8')
fs.writeFileSync('gl-dependency-scanning-report.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8')

process.exitCode = exitCode
