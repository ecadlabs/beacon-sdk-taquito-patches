'use strict'

const http = require('node:http')
const path = require('node:path')
const { stat, readFile } = require('node:fs/promises')

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

function isSubpath(rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath)

  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

async function resolveFilePath(rootPath, requestUrl) {
  const requestPath = decodeURIComponent(requestUrl.split('?')[0].split('#')[0])
  const relativePath = requestPath === '/' ? './index.html' : `.${requestPath}`
  let targetPath = path.resolve(rootPath, relativePath)

  if (!isSubpath(rootPath, targetPath)) {
    return null
  }

  let targetStats
  try {
    targetStats = await stat(targetPath)
  } catch {
    return undefined
  }

  if (targetStats.isDirectory()) {
    targetPath = path.join(targetPath, 'index.html')

    if (!isSubpath(rootPath, targetPath)) {
      return null
    }

    try {
      await stat(targetPath)
    } catch {
      return undefined
    }
  }

  return targetPath
}

function createStaticServer({ rootPath, port, name = 'beacon' }) {
  const absoluteRootPath = path.resolve(rootPath)
  const server = http.createServer(async (request, response) => {
    if (!request.url) {
      response.writeHead(400)
      response.end('Bad Request')

      return
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end()

      return
    }

    const filePath = await resolveFilePath(absoluteRootPath, request.url)

    if (filePath === null) {
      response.writeHead(403, { 'X-Powered-By': name })
      response.end('Forbidden')

      return
    }

    if (!filePath) {
      response.writeHead(404, { 'X-Powered-By': name })
      response.end('Not Found')

      return
    }

    const headers = {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'X-Powered-By': name
    }

    const fileContents = await readFile(filePath)

    response.writeHead(200, headers)

    if (request.method === 'HEAD') {
      response.end()
    } else {
      response.end(fileContents)
    }
  })

  return {
    port,
    server,
    start(callback) {
      server.listen(port, callback)
    },
    stop(callback) {
      server.close(callback)
    }
  }
}

module.exports = {
  createStaticServer,
  resolveFilePath
}
