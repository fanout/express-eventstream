const express = require('express')
const expressEventStream = require('express-eventstream')
const http = require('http')
const renderIndexHtml = require('./templates/index.html')
const { Readable } = require('stream')
const path = require('path')

function ClockEvents ({ interval = 1000 } = {}) {
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

function createDemoApplication ({ eventsUrl, grip }) {
  const clockEvents = ClockEvents({ interval: 5 * 1000 })
  const events = expressEventStream.events({ grip })
  clockEvents.pipe(events.channel('events-clock'))
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
 * Create a web server and have it start listening
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
