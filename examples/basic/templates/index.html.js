module.exports = ({ elementsUrl, eventsUrl }) => `
  <!doctype html>

  <script src="${elementsUrl}/demo-events-app.js"></script>

  <h1>express-eventstream basic demo</h1>

  <p>
  This page can open a streaming connection to /events/ and then print any messages that come from that connection.
  </p>

  <demo-events-app url="${eventsUrl}" />
`
