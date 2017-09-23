# Express EventStream

A library to easily create web endpoints that stream events to clients.

These endpoints speak [server-sent events (SSE)](https://en.wikipedia.org/wiki/Server-sent_events), so can be easily consumed in web browsers using [EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource).

The library is [GRIP-aware](http://pushpin.org/docs/protocols/grip/), which means it can be used with [Pushpin](http://pushpin.org/) or [Fanout Cloud](https://fanout.io/cloud/) for easy scaling.

## Examples

* [basic](./examples/basic/) - Publishes 'time' events every second on the 'clock' channel, and a web ui to show connection status, connection log, and event log

## Getting Started

* If using Pushpin locally, remember to enable "Auto Cross Origin" by adding the `aco` parameter to your routes config file

1. Create an `events` object, with optional GRIP configuration

    ```  
    // server.js
    const expressEventStream = require('express-eventstream')
    const grip = process.env.GRIP_URL // e.g. 'http://localhost:5561?key=changeme'
    const events = expressEventStream.events({ grip })
    ```

2. Create and mount the express handler wherever you want

    ```
    const yourApp = require('express')()
    yourApp.get('/events/', expressEventStream.express({ events, grip })
    ```

3. Publish events throughout your app

    ```
    yourApp.post('/messages/', (req, res, next) => {
      req.pipe(require('concat-stream')((reqBody) => {
        events.channel('messages').write({
          event: 'message',
          data: {text: reqBody.toString()}
        })
        res.status(201).end()
      }))
    })
    ```

    **Note**: If you're not using GRIP, and your application has several processes running, published events will only go to HTTP Connections on the process that publishes the message. To scale to more than one web server process, you'll need to use a [GRIP-compatible](http://pushpin.org/docs/protocols/grip/) proxy such as [Pushpin](http://pushpin.org/) or [Fanout Cloud](https://fanout.io/cloud/), and make sure you publish each event from one place.

4. Stream events to your web client using [EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)

    ```
    // client.js
    var eventSrc = new EventSource('/events/?channel=messages')
      .addEventListener('message', function (event) {
        console.log('message is', event.data)
      })
      .addEventListener('stream-error', function (event) {
        console.error('stream-error', event)
        this.close()
      })
    ```

## Protocol

The express handler created via `.express()` behaves as follows.

### Request

Make an HTTP GET request to your endpoint. You decide the path to mount it on. The endpoint will interpret the following querystring parameters:

* channel - Which channels you'd like to subscribe to events from.
  * If using Pushpin, the corresponding Pushpin channel names will all be prefixed with 'events-'. So if you provide '?channel=clock&channel=public', the underlying Pushpin channels will be 'events-clock' and 'events-public'. You can change this prefix via `.events({ prefix })`.

### Response

express-eventstream endpoints respond with text/event-stream responses. The Events in this Stream are one of a few predefined types, plus any others that you instruct it to publish. All of these events are prefixed with 'stream-', so consider using another prefix for your application's events.

If a 'data' field is present on these events, it will be a JSON-encoded string.

* stream-open - Sent whenever the endpoint starts sending SSE on a fresh HTTP Connection.
* stream-error - The endpoint could not understand what events are being requested. The client should not reconnect.
