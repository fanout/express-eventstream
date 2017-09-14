const { Transform } = require('stream')

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

let encoderId = 0
class ServerSentEventEncoder extends Transform {
  constructor () {
    super({ writableObjectMode: true })
    this._id = String(encoderId++)
  }
  _transform (event, encoding, callback) {
    this.push(textEventStream.stream(textEventStream.event(Object.assign({ encoder: this._id }, event))))
    callback()
  }
}

/**
 * Create an express middleware for an EventStream.
 * The middleware will respond to HTTP requests from Pushpin in order to
 * deliver any Events written to the EventStream
 */
exports.createMiddleware = function (eventStream, options) {
  let nextMessageId = 0
  const encodedEventStream = eventStream.pipe(new ServerSentEventEncoder())
  return httpRequestHandler(async function (req, res, next) {
    console.log('in express-eventstream request handler', req.params, req.method, req.url)
    // const eventRequest = await (options.createEventRequest || createEventRequest)(req)

    const initialEvents = []

    // TODO: may only be needed for certain browsers: https://github.com/Yaffle/EventSource/blob/master/README.md#browser-support
    // Don't send if not needed because it's just wasting data on mobile connections
    const userAgentRequiresPaddingBytes = 2048
    if (userAgentRequiresPaddingBytes) {
      initialEvents.push(textEventStream.event(null, Buffer.alloc(userAgentRequiresPaddingBytes).fill(' ').toString()))
    }

    initialEvents.push(textEventStream.event({
      id: String(++nextMessageId),
      event: 'stream-connected',
      data: ''
    }))

    res.format({
      'text/event-stream': () => {
        res.setHeader('Connection', 'Transfer-Encoding')
        res.setHeader('Transfer-Encoding', 'chunked')
        res.status(200)
        res.write(textEventStream.stream(initialEvents))
        encodedEventStream
          .pipe(res.on('finish', () => console.log('response finish (no more writes)'))
                   .on('close', () => console.log('response close')))
      },
      'default': () => res.status(406).send('Not Acceptable')
    })
  })
}

/**
 * Create an EventRequest from an express http request.
 * An EventRequest specifies what types of events a client wants.
 * Default implementation. An alternative can be provided on createMiddleware()
 */
// function createEventRequest (httpRequest) {
//   const channels = httpRequest.query.channels
//   return { channels }
// }

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
