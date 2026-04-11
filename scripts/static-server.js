'use strict'

const { createStaticServer } = require('./helpers/static-server')

const [, , rootPath = '.', portValue = '8080', name = 'beacon'] = process.argv
const port = Number.parseInt(portValue, 10)

if (!Number.isInteger(port) || port < 0) {
  throw new Error(`Invalid port: ${portValue}`)
}

const staticServer = createStaticServer({
  rootPath,
  port,
  name
})

staticServer.start(() => {
  console.log(`Serving ${rootPath} on port ${staticServer.server.address().port}`)
})

process.on('SIGINT', () => {
  staticServer.stop(() => process.exit(0))
})

process.on('SIGTERM', () => {
  staticServer.stop(() => process.exit(0))
})
