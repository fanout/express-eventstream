/* eslint require-jsdoc: "warn" */
/* eslint valid-jsdoc: ["warn", { "requireReturnDescription": false }] */
const express = require('express')
const expressEventStream = require('express-eventstream')
const http = require('http')
const renderIndexHtml = require('./templates/index.html')
const { Readable } = require('stream')
const path = require('path')

/**
 * Create a stream of time events
 * @param {Number} interval - milliseconds to wait between each event
 * @returns {Readable}
 */
function TimeEvents ({ interval = 1000 } = {}) {
  let started = false
  return new Readable({
    objectMode: true,
    read () {
      if (started) return
      setInterval(() => this.push({
        event: 'time',
        data: (new Date()).toISOString()
      }), interval)
      started = true
    }
  })
}

/**
 * Create an express application to power this demo
 * @param {String} eventsUrl - where the demo ui should connect its EventSource
 * @param {Object} grip - grip options
 * @param {String} grip.key - secret key that will be used to validate Grip-Sig headers
 * @param {String} grip.controlUri - URI of Control Plane server that will be used to publish events when using GRIP * @returns {express}
 * @returns {express.Application}
 */
function createDemoApplication ({ eventsUrl, grip }) {
  const timeEvents = TimeEvents({ interval: 5 * 1000 })
  const events = expressEventStream.events({ grip })
  timeEvents.pipe(events.channel('events-clock'))
  // for one-offs, you can always do events.channel('events-clock').write({ event: 'time', data: '...' })
  const app = express()
    .use(require('morgan')('tiny'))
    .use('/events/', expressEventStream.express({ events, grip }))
    .get('/', (req, res) => {
      res.format({
        html: () => res.send(renderIndexHtml({
          elementsUrl: '/elements',
          eventsUrl: req.query.eventsUrl || eventsUrl || '/events/'
        }))
      })
    })
    .use(express.static(path.join(__dirname, '/public')))
  return app
}

/**
 * Create a web server and have it start listening.
 * @returns {Promise} promise of the server shutting down successfully
 */
function main () {
  const app = createDemoApplication({
    eventsUrl: process.env.GRIP_URL || '/events/?channel=all',
    grip: {
      key: process.env.GRIP_KEY || 'changeme', // 'changeme' is the default key that ships with local pushpin
      controlUri: process.env.GRIP_CONTROL_URI || 'http://localhost:5561' // defaults to local pushpin
    }
  })
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
