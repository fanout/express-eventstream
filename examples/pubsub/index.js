/* eslint require-jsdoc: "warn" */
/* eslint valid-jsdoc: ["warn", { "requireReturnDescription": false }] */
const concat = require('concat-stream')
const express = require('express')
const expressEventStream = require('express-eventstream')
const http = require('http')
const { Readable } = require('stream')

/**
 * Create an express application to power this demo
 * @param {Object|String} grip - grip options
 * @param {String} grip.key - secret key that will be used to validate Grip-Sig headers
 * @param {String} grip.controlUri - URI of Control Plane server that will be used to publish events when using GRIP * @returns {express}
 * @returns {express.Application}
 */
function createDemoApplication ({ grip }) {
  const events = expressEventStream.events({ grip })

  const app = express()
    .use(require('morgan')('tiny'))
    .use('/events/', expressEventStream.express({ events, grip }))
    .post('/send/:channel/', (req, res, next) => {
      req.pipe(concat((reqBody) => {
        events.channel(req.params.channel).write({
          event: 'message',
          data: {text: reqBody.toString()}
        })
        res.status(201).end()
      }))
    })
  return app
}

/**
 * Create a web server and have it start listening.
 * @returns {Promise} promise of the server shutting down successfully
 */
function main () {
  const app = createDemoApplication({
    grip: process.env.GRIP_URL
  })
  const server = http.createServer(app)
  const port = process.env.PORT || 0
  if (!port) console.warn('use PORT environment variable to choose an HTTP port')
  return new Promise((resolve, reject) => {
    server.listen(port, (err) => {
      if (err) reject(err)
      console.warn(`listening on port ${server.address().port}`)
    })
  })
}

if (require.main === module) {
  process.on('unhandledRejection', (err, p) => {
    console.error('unhandledRejection', p.ben, p, err)
    process.exit(1)
  })
  main()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('main() error. shutting down')
      console.trace(err)
      process.exit(1)
    })
}
