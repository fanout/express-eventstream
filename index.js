const gripLib = require('grip')
const { Readable, PassThrough, Transform, Writable } = require('stream')
const debug = require('debug')('express-eventstream')
const { EventEmitter } = require('events')
/**
 * Represents an application's events, which can be published across one or more logical channels
 */
exports.events = ({ grip = {}, gripPubControl } = {}) => {
  if (!grip.controlUri) {
    console.warn('Will not be able to publish to gripPubControl with falsy uri: ', grip.controlUri)
  }
  gripPubControl = gripPubControl || new gripLib.GripPubControl({
    control_uri: grip.controlUri,
    key: grip.key
  })
  return Events({ gripPubControl })
}

function Events ({ gripPubControl }) {
  // all events written to all channels as { channel, event } objects
  let addressedEvents = new EventEmitter().on('addressedEvent', (ae) => debug('express-eventstream event', ae))
  return {
    /**
     * Return a Writable that represents a Channel.
     * Write event objects to it to publish to that channel
     */
    channel (channelName) {
      const pubControlWritable = new GripPubControlWritable(gripPubControl, channelName, { retryWait: 5000 })
        .on('error', (error) => {
          console.log('pubControlWritable error (does removing this cause unhandledRejection', error.name)
          throw error
        })
        .on('grip:published', ({ event, channel }) => debug('published to gripPubControl', channel, event))

      const channel = new Writable({
        objectMode: true,
        write (event, encoding, callback) {
          addressedEvents.emit('addressedEvent', { event, channel: channelName })
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
 * @TODO (bengo) jsdoc all the things, ensure passes eslint
 */

// "A colon as the first character of a line is in essence a comment, and is ignored."
// https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format
const textEventStreamCommentPrefix = ':'
const newline = '\n'
const textEventStream = {
  event: (fields, comments) => {
    let event = ''
    if (comments) {
      if (!Array.isArray(comments)) comments = [comments]
      for (let comment of comments) { event += textEventStreamCommentPrefix + comment + newline }
    }
    if (fields) {
      for (let [field, value] of Object.entries(fields)) {
        event += String(value)
          .split(newline)
          .map(chunk => field + ': ' + chunk)
          .join(newline)
        event += newline
      }
    }
    event += newline
    return event
  },
  stream: (events) => {
    if (!Array.isArray(events)) events = [events]
    return events.join('\n\n') + '\n\n'
  }
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
 */
function gripRequestFromHttp (req) {
  const gripRequest = Array.from(Object.entries(req.headers)).reduce((gripRequest, [header, value]) => {
    if (header.toLowerCase().startsWith('grip-')) {
      const key = header.replace(/^Grip-/i, '')
      gripRequest[key] = value
    }
    return gripRequest
  }, {})
  if (!Object.keys(gripRequest).length) {
    // was not grippy
    return
  }
  return gripRequest
}

/**
 * Writable stream that publishes written events to a Grip Control Publish endpoint
 */
class GripPubControlWritable extends Writable {
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

// if provided `doWork` function fails, retry until it succeeds
// waiting `wait`ms before trying again
// `onError` will be called on each failure
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
 * The middleware will respond to HTTP requests from Pushpin in order to
 * deliver any Events written to the EventStream
 * @param {expressEventStream.Events} options.events - stream of Event objects that will be sent to users
 * @param {Object} options.grip - Grip options
 * @param {String} options.grip.key - secret key that will be used to validate Grip-Sig headers
 * @param {String} options.grip.controlUri - URI of Control Plane server that will be used to publish events when using GRIP
 */
exports.express = function (options = {}) {
  options = Object.assign({ grip: {} }, options)

  // start pumping from the 'appEvents' provided by the user of this lib
  const appEvents = options.events
  // should emit { channel, event } objects
  const addressedEvents = new PassThrough({ objectMode: true })

  if (appEvents.createAddressedEventsReadable) {
    appEvents.createAddressedEventsReadable().pipe(addressedEvents)
  } else {
    if (appEvents) throw new Error('Unexpected value of options.events')
    else console.warn('No events will flow because none provided via options.events')
  }

  let nextMessageId = 0
  return httpRequestHandler(protocolErrorHandler(async function (req, res, next) {
    const gripRequest = gripRequestFromHttp(req)

    // validate sig
    if (gripRequest && gripRequest.sig && !gripLib.validateSig(gripRequest.sig, options.grip.key)) {
      throw new GripSigInvalidError('Grip-Sig invalid')
    }

    const eventRequest = (options.createEventRequestFromHttp || createEventRequestFromHttp)(req)
    const channels = eventRequest.channels

    if (!channels || !channels.length) {
      throw new ExpressEventStreamProtocolError('You must specify one or more channels to subscribe to using one or more ?channel querystring parameters')
    }

    // prefix with 'events-' for pushpin to isolate from other apps' using same pushpin
    const pushpinChannels = channels.map(c => `events-${c}`)
    const filteredAppEvents = addressedEvents.pipe(new AddressedEventFilter({ channels }))

    const initialEvents = []

    // TODO: may only be needed for certain browsers: https://github.com/Yaffle/EventSource/blob/master/README.md#browser-support
    // Don't send if not needed because it's just wasting data on mobile connections
    const userAgentRequiresPaddingBytes = 2048
    if (userAgentRequiresPaddingBytes) {
      initialEvents.push(textEventStream.event(null, Buffer.alloc(userAgentRequiresPaddingBytes).fill(' ').toString()))
    }

    initialEvents.push(textEventStream.event({
      id: String(++nextMessageId),
      event: 'stream-open',
      data: ''
    }))

    res.format({
      'text/event-stream': () => {
        res.status(200)

        if (gripRequest) {
          res.setHeader('Grip-Hold', 'stream')
          res.setHeader('Grip-Channel', gripLib.createGripChannelHeader(pushpinChannels.map(c => new gripLib.Channel(c))))
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

// create events for the 'stream-*' events that are specific
// to this library
const libraryProtocol = {
  event: (type, data, id) => Object.assign(
    { event: type },
    id && { id },
    data && { data: JSON.stringify(data) }
  ),
  errorEvent: function (condition, text) {
    const data = { condition, text }
    return this.event('stream-error', data, 'error')
  }
}

function protocolErrorHandler (handler) {
  return async function (req, res, next) {
    try {
      await handler(req, res, next)
    } catch (error) {
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
          },
          default: () => {
            res.status(400).send(message)
          }
        })

        return
      }
      throw error
    }
  }
}

/**
 * Create an EventRequest from an express http request.
 * An EventRequest specifies what types of events a client wants.
 * Default implementation. An alternative can be provided on createMiddleware()
 */
function createEventRequestFromHttp (req) {
  let channels = req.query.channel
  if (!Array.isArray(channels)) {
    channels = [channels]
  }
  return { channels }
}

/*
Wrap an async function and return an Express http handler
usage:
  express().get('/route', httpRequestHandler(async (req, res, next) => {
    throw 'thrown errors will get sent to next()'
  }))
*/
function httpRequestHandler (handleRequest) {
  return async (req, res, next) => {
    let calledNext = false
    let nextForExpress = (...args) => {
      calledNext = true
      next(...args)
    }
    try {
      await handleRequest(req, res, nextForExpress)
    } catch (error) {
      return nextForExpress(error)
    }
    if (!calledNext) nextForExpress()
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

/**
# -*- coding: utf-8 -*-
from __future__ import unicode_literals

from django.conf import settings
from django.http import HttpResponseBadRequest

def events(request):
  from .eventrequest import EventRequest
  from .eventstream import EventPermissionError, get_events
  from .utils import sse_error_response

  user = None
  if request.user.is_authenticated:
    user = request.user

  try:
    event_request = EventRequest(request)
    event_response = get_events(event_request, user=user)
    response = event_response.to_http_response(request)
  except EventRequest.ResumeNotAllowedError as e:
    response = HttpResponseBadRequest(
      'Invalid request: %s.\n' % str(e))
  except EventRequest.GripError as e:
    if request.grip_proxied:
      response = sse_error_response(
        'internal-error',
        'Invalid internal request.')
    else:
      response = sse_error_response(
        'bad-request',
        'Invalid request: %s.' % str(e))
  except EventRequest.Error as e:
    response = sse_error_response(
      'bad-request',
      'Invalid request: %s.' % str(e))
  except EventPermissionError as e:
    response = sse_error_response(
      'forbidden',
      str(e),
      {'channels': e.channels})

  response['Cache-Control'] = 'no-cache'

  if hasattr(settings, 'EVENTSTREAM_ALLOW_ORIGIN'):
    cors_origin = settings.EVENTSTREAM_ALLOW_ORIGIN
  else:
    cors_origin = request.META.get('HTTP_HOST')

  if cors_origin:
    response['Access-Control-Allow-Origin'] = cors_origin

  return response

*/
