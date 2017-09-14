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
    eventsUrl: process.env.GRIP_URL
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

function createDemoApplication (settings) {
  const router = express.Router()
  router.route('/')
    .get((req, res) => {
      const eventsUrl = req.query.eventsUrl || settings.eventsUrl || '/events/'
      const context = {
        elementsUrl: '/elements',
        eventsUrl
      }
      res.format({
        html: () => res.send(renderIndexHtml(context))
      })
    })

  // const eventStream = expressEventStream()
  const eventStream = new PassThrough({ readableObjectMode: true, writableObjectMode: true })
  setInterval(() => {
    console.log('writing time...')
    eventStream.write({
      event: 'time',
      data: (new Date()).toISOString()
    })
  }, 1000 * 3)

  const app = express()
    .use(require('morgan')('tiny'))
    .use('/events/', expressEventStream.createMiddleware(eventStream))
    .use(express.static(path.join(__dirname, '/public')))
    .use(router)

  return app
}
