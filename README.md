# express-eventstream

A library to easily create web endpoints that stream events to clients.

These endpoints speak [server-sent events (SSE)](https://en.wikipedia.org/wiki/Server-sent_events), so can be easily consumed in web browsers using [EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource).

These endpoints are also [GRIP-aware](pushpin.org/docs/protocols/grip/), so they can be used with [Pushpin](http://pushpin.org/) or the [Fanout.io cloud service](https://fanout.io/) to easily scale out your real-time APIs.

## Getting Started

* If using pushpin locally, remember to enable "Auto Cross Origin" by adding the `aco` parameter to your routes config file

## Protocol

### Request

Make a request to your endpoint (you decide the path to mount it on) over HTTP. The endpoint will interpret the following querystring parameters:

* channel - Which channels you'd like to subscribe to events from.
  * If using pushpin, the corresponding pushpin channel names will all be prefixed with 'events-'. So if you provide '?channel=clock&channel=public', the underlying pushpin channels will be 'events-clock' and 'events-public'.

### Response

express-eventstream endpoints respond with text/event-stream responses. The Events in this Stream are one of a few predefined types, plus any others that you instruct it to publish. All of these events are prefixed with 'stream-', so consider using another prefix for your application's events.

* stream-open - Sent whenever the endpoint starts sending SSE on a fresh HTTP Connection.
* stream-error - The endpoint could not understand what events are being requested. The client should not reconnect.