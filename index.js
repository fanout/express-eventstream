/* eslint require-jsdoc: "warn" */
/* eslint valid-jsdoc: ["warn", { "requireReturnDescription": false }] */
const gripLib = require('grip')
const { Readable, PassThrough, Transform, Writable } = require('stream')
const debug = require('debug')('express-eventstream')
const { EventEmitter } = require('events')
const url = require('url')

/**
 * Represents an application's events, which can be published across one or more logical channels
 * @param {Object|String} grip - Grip options or GRIP_URL
 * @param {String} grip.key - secret key that will be used to validate Grip-Sig headers
 * @param {String} grip.controlUri - URI of Control Plane server that will be used to publish events when using GRIP
 * @returns {Events} object your application can publish events to
 */
exports.events = ({ grip, gripPubControl, prefix = 'events-' } = {}) => {
  if (typeof grip === 'string') grip = parseGripUrl(grip)
  if (!gripPubControl && grip) {
    if (!grip.controlUri) {
      console.warn('Will not be able to publish to gripPubControl with falsy uri: ', grip.controlUri)
    }
    gripPubControl = new gripLib.GripPubControl({
      control_uri: grip.controlUri.replace(/\/$/, ''), // https://github.com/fanout/node-pubcontrol/pull/1
      key: grip.key
    })
  }
  return Events({ gripPubControl, prefix })
}

/**
 * Parse a GRIP_URL value into a grip options object
 * @param {String} gripUrl - like http://localhost:5561?key=changeme
 * @returns {Object} like { controlUri } + any other keys that were in querystring
 */
function parseGripUrl (gripUrl) {
  if (!gripUrl) return
  const parsedUrl = url.parse(gripUrl, true)
  const withoutQuery = url.format(Object.assign({}, parsedUrl, { query: {}, search: '' }))
  const gripOptions = Object.assign({}, parsedUrl.query, { controlUri: withoutQuery })
  return gripOptions
}

/**
 * An application's events, which can be published across one or more channels
 * @returns {Events}
 */
function Events ({ gripPubControl, prefix }) {
  if (!gripPubControl) debug('Events will not publish to grip because no gripPubControl', gripPubControl)
  // all events written to all channels as { channel, event } objects
  let addressedEvents = new EventEmitter().on('addressedEvent', (ae) => debug('express-eventstream event', ae))
  /*
   * @typedef Events
   * @type {Object}
   * @property {function} channel
   * @property {function} createAddressedEventsReadable
   */
  return {
    prefix,
    /**
     * Return a Writable that represents a Channel. Write event objects to it to publish to that channel.
     * @param {String} channelName - name of channel that written events will be published to
     * @returns {Writable}
     */
    channel (channelName) {
      const pubControlWritable = gripPubControl && new GripPubControlWritable(gripPubControl, `${prefix}${channelName}`, { retryWait: 5000 })
        .on('error', (error) => {
          console.log('pubControlWritable error (does removing this cause unhandledRejection', error.name)
          throw error
        })
        .on('grip:published', ({ event, channel }) => debug('published to gripPubControl', channel, event))

      const channel = new Writable({
        objectMode: true,
        write (event, encoding, callback) {
          addressedEvents.emit('addressedEvent', { event, channel: channelName })
          if (!pubControlWritable) {
            return callback()
          }
          // still give backpressure to anyone piping to this
          if (pubControlWritable.write(event)) {
            callback()
          } else {
            pubControlWritable.on('drain', callback)
          }
        }
      })

      return channel
    },
    /** 
     * Create a readable that will emit { channel, event } objects for any published events
     * @returns {Readable}
     */
    createAddressedEventsReadable () {
      let listening = false
      let listener = addressedEvent => readable.push(addressedEvent)
      const readable = new Readable({
        objectMode: true,
        read () {
          if (listening) return
          addressedEvents.on('addressedEvent', listener)
          listening = true
        },
        destroy () {
          if (listening) addressedEvents.removeListener('addressedEvent', listener)
          listening = false
        }
      })
      return readable
    }
  }
}

/**
 * tools for encoding objects to text/event-stream strings
 * https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format
 */
const textEventStream = {
  /**
   * encode an event
   * @param {Object} fields - Fields the events hould have, e.g. { data: 'foo' }
   * @param {Array<String>} comments - Any comments the event should have. They will be ignored by most clients.
   * Comments are printed before fields
   * @returns {String} text/event-stream encoded event
   */
  event (fields, comments) {
    let event = ''
    if (comments) {
      if (!Array.isArray(comments)) comments = [comments]
      for (let comment of comments) { event += this.commentPrefix + comment + this.newline }
    }
    if (fields) {
      for (let field of Object.keys(fields)) {
        const value = fields[field]
        event += String(value)
          .split(this.newline)
          .map(chunk => field + ': ' + chunk)
          .join(this.newline)
        event += this.newline
      }
    }
    event += this.newline
    return event
  },
  /**
   * encode one or more events into a stream
   * @param {(Object|Array<Object>)} events - events to encode
   * @returns {String} text/event-stream encoded stream
   */
  stream (events) {
    if (!Array.isArray(events)) events = [events]
    return events.join('\n\n')
  },
  commentPrefix: ':',
  newline: '\n'
}

/**
 * Transform stream that encodes written event objects to text/event-stream text
 */
class ServerSentEventEncoder extends Transform {
  constructor () {
    super({ writableObjectMode: true })
  }
  _transform (event, encoding, callback) {
    try {
      this.push(textEventStream.event(event))
    } catch (error) {
      return callback(error)
    }
    callback()
  }
}

/**
 * given an http request, return an object with any grip-specific instructions (by parsing headers)
 * If there is no sign of the client speaking grip, return falsy
 * @param {http.IncomingMessage} req - http request
 * @returns {(Object|null)} grip request with keys like grip headers, but with 'Grip-' stripped.
 * If the request appears to be from a client that doesn't speak GRIP, return undefined
 */
function gripRequestFromHttp (req) {
  const gripRequest = Object.keys(req.headers).reduce((gripRequest, header) => {
    const value = req.headers[header]
    if (header.toLowerCase().startsWith('grip-')) {
      const key = header.replace(/^Grip-/i, '')
      gripRequest[key] = value
    }
    return gripRequest
  }, {})
  if (!Object.keys(gripRequest).length) {
    // was not grippy
    return null
  }
  return gripRequest
}

/**
 * Writable stream that publishes written events to a Grip Control Publish endpoint
 */
class GripPubControlWritable extends Writable {
  /**
   * @param {gripLib.GripPubControl} gripPubControl - configured GripPubControl used to publish content
   * @param {string} channel - name of channel to publish to
   * @param {(Number|Boolean)} retryWait - if truthy, number of milliseconds to wait before retrying failed publish attempts.
   * If falsy, there will be no retrying and the writable will emit an error
   */
  constructor (gripPubControl, channel, { retryWait = 5000 } = {}) {
    super({
      objectMode: true,
      write (event, encoding, callback) {
        const sseEncodedEvent = textEventStream.event(event)
        let publish = (channel, content) => {
          return new Promise((resolve, reject) => {
            gripPubControl.publishHttpStream(channel, content, (success, message, context) => {
              if (success) {
                this.emit('grip:published', { event, channel })
                resolve()
              } else {
                reject(new GripPublishFailedError(message, context))
              }
            })
          })
        }
        if (retryWait) {
          publish = retry(publish, {
            wait: retryWait,
            onError: (error) => {
              console.warn(`Error publishing to Grip Control. Will retry in ${retryWait}ms`, error)
            }
          })
        }
        publish(channel, sseEncodedEvent)
          .catch(callback)
          .then(() => {
            callback()
          })
      }
    })
  }
}

/**
 * wrap a function such that it retries until it doesn't error
 * @param {function} doWork - function to wrap
 * @param {Number} wait - wait this many milliseconds between tries
 * @param {function} onError - will be called on each failure with error
 * @returns {function} function with same signature as doWork, but retries
 */
function retry (doWork, { wait = 1, onError } = {}) {
  return (...args) => new Promise((resolve, reject) => {
    const tryIt = () => {
      doWork(...args).then(resolve).catch((error) => {
        if (typeof onError === 'function') onError(error)
        setTimeout(tryIt, wait)
      })
    }
    tryIt()
  })
}

/**
 * Pipe streams together, but propogate errors downstream
 * http://grokbase.com/t/gg/nodejs/12bwd4zm4x/should-stream-pipe-forward-errors
 * @param {...Stream} var_args - streams to pipe together
 * @returns {Writable} the last stream
 */
function pipeWithErrors () { // eslint-disable-line no-unused-vars 
  let [src, ...streams] = Array.prototype.slice.call(arguments)
  let dest
  for (let stream of streams) {
    dest = stream
    src.once('error', (error) => {
      dest.emit('error', error)
    })
    src.pipe(dest)
    src = dest
  }
  return dest
}

class AddressedEventFilter extends Transform {
  constructor ({ channels = [] } = {}) {
    super({
      objectMode: true,
      transform (addressedEvent, encoding, callback) {
        if (channels.includes(addressedEvent.channel)) {
          this.push(addressedEvent.event)
        } else {
          debug('AddressedEventFilter not pushing along event because didnt match filter', addressedEvent, {filter: { channels }})
        }
        callback()
      }
    })
  }
}

/**
 * Create an express middleware for an EventStream.
 * The middleware will respond to HTTP requests from Pushpin in order to deliver any Events written to the EventStream.
 * If the request does not speak GRIP, it will stream application events over HTTP Chunked
 * If the request does speak GRIP, it is assumed that you will publish events separately. Only 'stream-open' event will be sent here.
 * @param {Object} options - options
 * @param {Events} options.events - events from your application. They will be filtered for each request based on which channels are subscribed to via ?channel query param
 * @param {Object} options.grip - Grip options
 * @param {String} options.grip.key - secret key that will be used to validate Grip-Sig headers
 * @param {String} options.grip.controlUri - URI of Control Plane server that will be used to publish events when using GRIP
 * @returns {function} express http handler
 */
exports.express = function (options = {}) {
  if (typeof options.grip === 'string') options.grip = parseGripUrl(options.grip)
  options = Object.assign({ grip: {} }, options)

  // start pumping from the 'appEvents' provided by the user of this lib
  const appEvents = options.events
  // should emit { channel, event } objects
  const addressedEvents = new PassThrough({ objectMode: true })

  if (appEvents && appEvents.createAddressedEventsReadable) {
    appEvents.createAddressedEventsReadable().pipe(addressedEvents)
  } else {
    if (appEvents) throw new Error('Unexpected value of options.events')
    else console.warn('No events will flow because none provided via options.events')
  }

  return httpRequestHandler(protocolErrorHandler(function (req, res, next) {
    const gripRequest = options.grip && gripRequestFromHttp(req)

    // validate sig
    if (gripRequest && gripRequest.sig && !gripLib.validateSig(gripRequest.sig, options.grip.key)) {
      return Promise.reject(new GripSigInvalidError('Grip-Sig invalid'))
    }

    const lastEventId = req.headers['last-event-id']
    if (lastEventId === 'error') {
      return res.status(400).send(`last-event-id header may not be 'error'`)
    }

    const eventRequest = (options.createEventRequestFromHttp || createEventRequestFromHttp)(req)
    const channels = eventRequest.channels

    if (!channels || !channels.length) {
      return Promise.reject(new ExpressEventStreamProtocolError('You must specify one or more channels to subscribe to using one or more ?channel querystring parameters'))
    }

    // prefix with appEvents.prefix for pushpin to isolate from other apps' using same pushpin
    const filteredAppEvents = addressedEvents.pipe(new AddressedEventFilter({ channels }))
    const prefixedChannels = channels.map(c => `${appEvents.prefix}${c}`)
    const initialEvents = []

    // TODO: may only be needed for certain browsers: https://github.com/Yaffle/EventSource/blob/master/README.md#browser-support
    // Don't send if not needed because it's just wasting data on mobile connections
    const userAgentRequiresPaddingBytes = 2048
    if (userAgentRequiresPaddingBytes) {
      initialEvents.push(textEventStream.event(null, Buffer.alloc(userAgentRequiresPaddingBytes).fill(' ').toString()))
    }

    initialEvents.push(textEventStream.event({
      event: 'stream-open',
      data: ''
    }))

    res.format({
      'text/event-stream': () => {
        res.status(200)

        if (gripRequest) {
          res.setHeader('Grip-Hold', 'stream')
          res.setHeader('Grip-Channel', gripLib.createGripChannelHeader(prefixedChannels.map(c => new gripLib.Channel(c))))
          // stringify to escale newlines into '\n'
          const keepAliveHeaderValue = [
            textEventStream.event({
              event: 'keep-alive',
              data: ''
            }).replace(/\n/g, '\\n'),
            'format=cstring',
            'timeout=20'
          ].join('; ')
          res.setHeader('Grip-Keep-Alive', keepAliveHeaderValue)
        } else {
          // do normal SSE over chunked HTTP
          res.setHeader('Connection', 'Transfer-Encoding')
          res.setHeader('Transfer-Encoding', 'chunked')
        }

        // TODO: may need to not do this if it's a gripRequest re-connecting/paging
        // TODO: maybe dont include padding bytes if pushpin/grip
        res.write(textEventStream.stream(initialEvents))

        if (gripRequest) {
          // return early. user events will be delivered via pubcontrol
          debug('its grip, returning early')
          res.end()
          return
        }

        // @TODO (bengo) all responses will only go as fast as the slowest response socket. Might be good to use something like
        // npm.im/fastest-writable to drop slow connections (who could recover via lastEventId) (https://stackoverflow.com/a/33879208 might also be useful)
        debug('piping encoded to res')
        filteredAppEvents
          .pipe(new ServerSentEventEncoder())
          .pipe(res)
          .on('finish', () => debug('response finish (no more writes)'))
          .on('close', () => debug('response close'))
      },
      'default': () => res.status(406).send('Not Acceptable')
    })
  }))
}

/**
 * create event objects for the 'stream-*' event types that are specific to how this library signals connection status
 */
const libraryProtocol = {
  /**
   * Create an event. It's properties will be such that it is also compatible with textEventStream.event.
   * @param {String} type - event type
   * @param {*} [data] - data to go along with event.
   * @param {String} [id] - event id 
   * @returns {Object}
   */
  event: (type, data, id) => Object.assign(
    { event: type },
    id && { id },
    data && { data: JSON.stringify(data) }
  ),
  /**
   * Create an error event (type will be stream-error)
   * @param {String} condition - code-readable error condition, e.g. 'bad-request'
   * @param {String} text - human readable error message, e.g. 'Bad Request'
   * @returns {Object}
   */
  errorEvent: function (condition, text) {
    const data = { condition, text }
    return this.event('stream-error', data, 'error')
  }
}

/**
 * Wrap an express http handler to catch common ExpressEventStreamProtocolErrors and
 * properly respond to the http request.
 * @param {function} handler - express http handler
 * @returns {function} wrapped express http handler
 */
function protocolErrorHandler (handler) {
  return function (req, res, next) {
    return Promise.resolve(handler(req, res, next)).catch(error => {
      if (error instanceof ExpressEventStreamProtocolError) {
        debug('ExpressEventStreamProtocolError', error.name, error.message)
        const message = 'Bad Request: ' + error.message
        res.format({
          'text/event-stream': () => {
            res.status(200)
            res.setHeader('content-type', 'text/event-stream')
            res.write(textEventStream.stream(textEventStream.event(
              libraryProtocol.errorEvent('bad-request', message)
            )))
            res.end()
          },
          default: () => {
            res.status(400).send(message)
          }
        })
        return
      }
      throw error
    })
  }
}

/**
 * Create an EventRequest from an express http request.
 * An EventRequest specifies what types of events a client wants.
 * Default implementation. An alternative can be provided on createMiddleware()
 * @param {http.IncomingMessage} req - http request
 * @returns {EventRequest}
 */
function createEventRequestFromHttp (req) {
  let channels = req.query.channel
  if (!Array.isArray(channels)) {
    channels = [channels].filter(Boolean)
  }
  /*
   * @typedef EventRequest
   * @type {Object}
   * @property {Array<String>} channels - Channels that the requestor would like to subscribe to
   */
  return { channels }
}

/**
 * Wrap an express handler such that the handler can return a promise.
 * If the promise is rejected, the error will be passed to express' next() function
 * If the promise is resolved, next() will be called with no error, so future middlewares are called
 * If not promise is returned, success is assumed, and next() will be called with no error.
 * @example
 * express().get('/route', httpRequestHandler(async (req, res, next) => {
 *   throw 'thrown errors will get sent to next()'
 * }))
 * @param {function} handleRequest - express http handler that can return a promise
 * @returns {function} wrapped express http request handler
 */
function httpRequestHandler (handleRequest) {
  return (req, res, next) => {
    let calledNext = false
    let nextForExpress = (...args) => {
      calledNext = true
      next(...args)
    }
    handleRequest(req, res, nextForExpress)
      .catch(nextForExpress)
      .then(() => {
        if (!calledNext) nextForExpress()
      })
  }
}

// Base Class for custom errors
// https://stackoverflow.com/a/31090384
class ExtendableError extends Error {
  constructor (message) {
    super(message)
    this.name = this.constructor.name
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor)
    } else {
      this.stack = (new Error(message)).stack
    }
  }
}

class ExpressEventStreamError extends ExtendableError {}

class GripSigInvalidError extends ExpressEventStreamError {}

class GripPublishFailedError extends ExpressEventStreamError {
  constructor (message, context) {
    super()
    Object.assign(this, { context })
  }
}

// When the client does something against the protocol that this library depends on, like:
// * requesting events without specifying ?channel
class ExpressEventStreamProtocolError extends ExpressEventStreamError {}
