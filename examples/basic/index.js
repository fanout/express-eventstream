const express = require('express')
const expressEventStream = require('express-eventstream')
const http = require('http')

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      console.trace(err)
      process.exit(1)
    })
}

/**
 * Create a web server and have it start listening
 */
function main() {
  const router = express.Router()
  router.route('/')
    .get((req, res) => {
      const name = req.query.name || 'you'
      res.json({
        message: `hello, ${name}`
      })
    })
  
  const app = express()
    .use(require('morgan')('tiny'))
    .use(expressEventStream.createMiddleware())
    .use(router)
  const server = http.createServer(app)
  const port = process.env.PORT || 0
  return new Promise((resolve, reject) => {
    process.once('SIGINT', async function () {
      console.warn('SIGINT: closing server')
      server.close(err => {
        if (err) return reject(err)
        return resolve()
      })
    })
    server.listen(port, (err) => {
      console.warn(`listening on port ${server.address().port}`)
    })
  })
}