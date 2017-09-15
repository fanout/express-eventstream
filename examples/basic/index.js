const express = require('express')
const expressEventStream = require('express-eventstream')
const http = require('http')
const renderIndexHtml = require('./templates/index.html')
const { PassThrough } = require('stream')
const path = require('path')

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
function main () {
  const app = createDemoApplication({
    eventsUrl: process.env.GRIP_URL,
    grip: {
      key: process.env.GRIP_KEY || 'changeme' // 'changeme' is the default key that ships with local pushpin
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

function createDemoApplication ({ eventsUrl, grip }) {
  const router = express.Router()
  router.route('/')
    .get((req, res) => {
      res.format({
        html: () => res.send(renderIndexHtml({
          elementsUrl: '/elements',
          eventsUrl: req.query.eventsUrl || eventsUrl || '/events/'
        }))
      })
    })

  const events = new PassThrough({ readableObjectMode: true, writableObjectMode: true })
  // TODO: publish on 'clock' channel
  setInterval(() => {
    events.write({
      event: 'time',
      data: (new Date()).toISOString()
    })
  }, 1000 * 3)

  const app = express()
    .use(require('morgan')('tiny'))
    .use('/events/', expressEventStream.createMiddleware({ events, grip }))
    .use(express.static(path.join(__dirname, '/public')))
    .use(router)

  return app
}
