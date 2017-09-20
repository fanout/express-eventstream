const expressEventStream = require('../')
const { assert } = require('chai')

module.exports = {
  'express-eventstream': {
    '#events()': () => {
      expressEventStream.events()
    },
    '#express()': () => {
      expressEventStream.express()
    }
  }
}
