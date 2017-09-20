/* eslint require-jsdoc: "warn" */
/* eslint valid-jsdoc: ["warn", { "requireReturnDescription": false }] */
const concat = require('concat-stream')
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
      const makeTimeEvent = () => ({
        event: 'time',
        data: (new Date()).toISOString()
      })
      this.push(makeTimeEvent())
      setInterval(() => this.push(makeTimeEvent()), interval)
      started = true
    }
  })
}

/**
 * Create an express application to power this demo
 * @param {String} eventsUrl - where the demo ui should connect its EventSource
 * @param {Object|String} grip - grip options
 * @param {String} grip.key - secret key that will be used to validate Grip-Sig headers
 * @param {String} grip.controlUri - URI of Control Plane server that will be used to publish events when using GRIP * @returns {express}
 * @returns {express.Application}
 */
function createDemoApplication ({ eventsUrl, grip }) {
  const timeEvents = TimeEvents({ interval: 5 * 1000 })
  const events = expressEventStream.events({ grip })
  timeEvents.pipe(events.channel('clock'))
  // for one-offs, you can always do events.channel('clock').write({ event: 'time', data: '...' })
  const app = express()
    .use(require('morgan')('tiny'))
    .use('/events/', expressEventStream.express({ events, grip }))
    .get('/', (req, res) => {
      res.format({
        html: () => res.send(renderIndexHtml({
          publicUrl: '/',
          eventsUrl: req.query.eventsUrl || eventsUrl || '/events/'
        }))
      })
    })
    .post('/messages/', (req, res, next) => {
      req.pipe(concat((reqBody) => {
        events.channel('messages').write({
          event: 'message',
          data: reqBody.toString()
        })
        res.status(201).end()
      }))
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
    eventsUrl: process.env.EVENTS_URL || '/events/?channel=clock',
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
