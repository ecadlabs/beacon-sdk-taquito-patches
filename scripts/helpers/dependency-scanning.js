'use strict'

function getPriority(priority) {
  switch ((priority || '').toLowerCase()) {
    case 'moderate':
      return 'Medium'
    case 'low':
      return 'Low'
    default:
      return 'High'
  }
}

function getSolution(fixAvailable) {
  if (fixAvailable && typeof fixAvailable === 'object' && fixAvailable.name && fixAvailable.version) {
    return `Upgrade to ${fixAvailable.name}@${fixAvailable.version}`
  }

  if (fixAvailable) {
    return 'Upgrade to a patched version'
  }

  return null
}

function normalizeCwe(cwe) {
  if (!cwe) {
    return []
  }

  return Array.isArray(cwe) ? cwe : [cwe]
}

function createDependencyScanningReport(audit) {
  const vulnerabilities = Object.values(audit.vulnerabilities || {})
  const result = []

  for (const vulnerability of vulnerabilities) {
    for (const advisory of vulnerability.via || []) {
      if (!advisory || typeof advisory === 'string') {
        continue
      }

      result.push({
        message: `${advisory.title}\n\nAffected package: ${vulnerability.name}`,
        cve: null,
        cwe: normalizeCwe(advisory.cwe),
        solution: getSolution(vulnerability.fixAvailable),
        url: advisory.url,
        priority: getPriority(advisory.severity || vulnerability.severity)
      })
    }
  }

  return result
}

module.exports = {
  createDependencyScanningReport
}
