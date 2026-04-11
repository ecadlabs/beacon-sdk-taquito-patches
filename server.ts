const { createStaticServer } = require('./scripts/helpers/static-server')

const server1 = createStaticServer({
  rootPath: './examples/',
  port: 8080,
  name: 'beacon'
})
const server2 = createStaticServer({
  rootPath: './examples/',
  port: 8081,
  name: 'beacon'
})

server1.start(function () {
  console.log('Server1 listening to', server1.port)
  server2.start(function () {
    console.log('Server2 listening to', server2.port)
  })
})
