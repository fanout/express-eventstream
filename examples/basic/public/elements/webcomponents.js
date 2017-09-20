(function () {
  if ('registerElement' in document &&
      'import' in document.createElement('link') &&
      'content' in document.createElement('template')) {
    // platform is good!
  } else {
    // polyfill the platform!
    var e = document.createElement('script')
    e.src = '/bower_components/webcomponentsjs/webcomponents-lite.min.js'
    document.body.appendChild(e)
  }
})()
