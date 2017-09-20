module.exports = ({ publicUrl, eventsUrl }) => `
  <!doctype html>

  <h1>express-eventstream basic demo</h1>

  <p>
  This page can open a streaming connection to /events/ and then print any messages that come from that connection.
  </p>

  <demo-events-app url="${eventsUrl}" />

  <script src="${publicUrl}polyfills/webcomponents/webcomponents-loader.js"></script>
  <script src="${publicUrl}elements/demo-events-app.js"></script>

`
