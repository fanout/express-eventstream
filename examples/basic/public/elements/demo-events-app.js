/* eslint-env browser */
(function (customElementsReady) {
  if ('customElements' in window) return customElementsReady()
  else if (window.WebComponents) window.addEventListener('WebComponentsReady', customElementsReady)
  else throw new Error('user-agent does not support Custom Elements')
})(function () {
  const ConnectionStates = makeEnum(
    'uninitialized',
    'connecting',
    'open',
    'closed'
  )

  const EventSourceReadyStateToConnectionStates = [
    ConnectionStates.connecting,
    ConnectionStates.open,
    ConnectionStates.closed
  ]

  // Main Custom Element that renders the basic demo
  class DemoEventsApp extends HTMLElement {
    get initialState () {
      return {
        connectionLog: [],
        connectionState: ConnectionStates.uninitialized,
        eventLog: []
      }
    }
    constructor () {
      super()
      this._connected = false
      this.setState(this.initialState)
    }
    connectedCallback () {
      this._connected = true
      this.initialize()
      this._render()
    }
    initialize () {
      this._initializeConnection()
    }
    _initializeConnection () {
      if (this.state.connection) {
        throw new Error('_initializeConnection called when connection already exists')
      }
      const connectionUrl = this.getAttribute('url')
      if (!connectionUrl) {
        const msg = 'DemoEventsApp cannot initializeConnection because it was not provided any `url` attribute'
        console.warn(msg)
        this._appendToConnectionLog(msg)
        return
      }
      this._appendToConnectionLog(`Starting connection initialization for ${connectionUrl}`)
      const eventSource = new EventSource(connectionUrl)
      this.setState({
        connection: eventSource
      })
      // bind listeners for connectionState
      const connectionListener = createEventListener(Object.assign(
        ['open', 'error', 'close'].reduce((handlers, eventName) => {
          handlers[eventName] = event => {
            console.debug(`eventSource ${eventName}`, event)
            this._setConnectionStateFromEventSource(event.target)
            this._appendToConnectionLog(eventName)
          }
          return handlers
        }, {}),
        ['message', 'time', 'stream-open'].reduce((handlers, eventName) => {
          handlers[eventName] = (event) => {
            this._appendToEventLog(event)
          }
          return handlers
        }, {}),
        {
          'stream-error': (event) => {
            // means the client shouldn't reconnect.
            this._appendToEventLog(event)
            this._closeConnection()
            this._appendToConnectionLog('Will not re-connect due to stream-error')
          }
        }
      ))
      connectionListener.listenTo(eventSource)
      this.setState({ connectionListener })
    }
    _setConnectionStateFromEventSource (eventSource) {
      const connectionState = EventSourceReadyStateToConnectionStates[eventSource.readyState]
      this.setState({ connectionState })
    }
    _closeConnection () {
      const { connection } = this.state
      connection.close()
      connection.dispatchEvent(new Event('close'))
    }
    _appendToConnectionLog (message) {
      this.setState({
        connectionLog: this.state.connectionLog.concat([message])
      })
    }
    _appendToEventLog (event) {
      this.setState({
        eventLog: this.state.eventLog.concat([event])
      })
    }
    render () {
      const html = `
        <h2>Connection</h2>
        <dl>
          <dt>Status</dt><dd>${this.state.connectionState}</dd>
        </dl>
        <h3>Connection Log</h3>
        <ol id="connection-log">${
  this.state.connectionLog
    .map(log => {
      return `<li>${log}</li>`
    })
    .join('\n')
}</ol>

        <h2>Events</h2>
        <ul id="events-list">${
  this.state.eventLog
    .map(event => {
      return `<li>${event.type} - ${event.data}</li>`
    })
    .join('\n')
}</ul>
      `
      return html
    }
    setState (state) {
      console.debug('setState', state, { oldState: this.state })
      this.state = Object.assign({}, this.state, state)
      this._render()
    }
    _render () {
      const html = this.render()
      if (html === this._html) {
        return
      }
      this._html = html
      if (this._connected) {
        this.innerHTML = html
      }
    }
    attributeChangedCallback (attr, oldValue, newValue) {
      this._render()
    }
    disconnectedCallback () {
      this._connected = false
    }
  }
  window.customElements.define('demo-events-app', DemoEventsApp)

  // Return an object whose properties and values always match
  // and that has only the properties provided in `keys`
  function makeEnum (...keys) {
    return keys.reduce((obj, key) => {
      obj[key] = key
      return obj
    }, {})
  }

  /*
usage:
  const listener = createEventListener({
    error: function (event) => {
      console.log('error event!', event)
      console.log('will stop listening since error')
      this.stopListening(event.target)
    }
  })
  htmlElement.addEventListener('error', listener)
  // when you want to clean up right now
  listener.stopListening(htmlElement)
  // or to have listener remove itself itself up whenever it handles
  // any other event
  listener.stopListening()
*/
  function createEventListener (eventTypeToHandler) {
    let stopped = false
    const api = {
      listenTo (element) {
        Object.keys(eventTypeToHandler).forEach(eventType => {
          element.addEventListener(eventType, this)
        })
      },
      handleEvent (event) {
        if (stopped) {
          event.currentTarget.removeEventListener(event.type, this)
          return
        }
        const handler = eventTypeToHandler[event.type]
        if (handler) {
          handler.call(this, event)
        }
      },
      // if `optionalElement` is passed, listeners will be removed now,
      // otherwise they will be removed on next handleEvent
      stopListening (optionalElement) {
        if (optionalElement) {
          Object.keys(eventTypeToHandler).forEach(eventType => {
            optionalElement.removeEventListener(eventType, this)
          })
        } else {
          stopped = true
        }
      }
    }
    return Object.assign(api, eventTypeToHandler)
  }
})
