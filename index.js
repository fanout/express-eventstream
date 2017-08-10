exports.createMiddleware = function () {
  return function (req, res, next) {
    // console.log('in express-eventstream mw')
    return next()
  }
}
