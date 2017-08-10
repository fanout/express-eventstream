const expressEventStream = require('../')
const { assert } = require('chai')

module.exports = {
  'express-eventstream': {
    '#createMiddleware()': () => {
      const middleware = expressEventStream.createMiddleware()
    }
  }
};
