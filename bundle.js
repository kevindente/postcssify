'use strict'

var path = require('path')
var hh = require('http-https')
var postcss = require('postcss')
var browserResolve = require('browser-resolve')
var detective = require('detective')
var cssDetective = require('css-detective')
var fs = require('vigour-fs-promised')
var isURL = require('vigour-util/is/url')
var logError = require('./logerror.js')

const key = 'PostCSSifySingleton'
const importRE = /@import[^;]*;/g

module.exports = exports = {}

exports.getInstance = function getInstance (global, options) {
  if (!global[key]) {
    global[key] = new exports.Bundle(options)
  }
  if (!global[key].options) {
    global[key].options = {}
  }
  if (!global[key].options.plugins) {
    global[key].options.plugins = []
  }
  if (options.force) { // TODO find another way to do this
    for (let i = 0, len = options.force.length; i < len; i += 1) {
      global[key].options[options.force[i]] = options[options.force[i]]
    }
  }
  if (options.plugins) {
    if (typeof options.plugins === 'string') {
      options.plugins = [options.plugins]
    }
    for (let i = 0, len = options.plugins.length; i < len; i += 1) {
      if (global[key].options.plugins.indexOf(options.plugins[i]) === -1) {
        global[key].options.push(options.plugins[i])
      }
    }
  }
  return global[key]
}

exports.Bundle = function Bundle (options) {
  options.out = options.out
    ? path.resolve(options.out)
    : path.join(process.cwd(), 'bundle.css')
  if (typeof options.map === 'undefined' ||
    options.map === 'true' ||
    options.map === 'inline' ||
    options.map === true) {
    options.map = true
  } else if (options.map === 'false' || options.map === false) {
    options.map = false
  } else {
    options.map = options.map
  }
  this.options = options
}

exports.Bundle.prototype.addFile = function addFile (file, body, deps, options, isCSS) {
  if (!this.files) {
    // First file transformed is considered the entry for the lifetime of this Bundle
    this.entry = file
    this.files = {}
  }
  this.files[file] = { name: file, deps, body, options, isCSS }
}

exports.Bundle.prototype.addCSS = function addCSS (file, body, options) {
  var imports = cssDetective(body)
  this.addFile(file, body, imports, options, true)
  var requires = []
  imports.map((item) => {
    if (isURL(item, { requireProtocol: true })) {
      this.files[item] = { name: item, deps: [], isURL: true, isCSS: true }
    } else {
      requires.push(exports.toRequire(item))
    }
  })
  if (requires.length) {
    return ';' + requires.join(';') + ';'
  } else {
    return ''
  }
}

exports.Bundle.prototype.addJS = function addCSS (file, body, deps, options) {
  var requires = detective(body)
  this.addFile(file, body, requires, options)
  return body
}

exports.Bundle.prototype.loadRemote = function loadRemote (filename) {
  if (this.files[filename].cache) {
    return Promise.resolve(this.files[filename].cache)
  }
  if (!this.downloads) {
    this.downloads = {}
  }
  if (!this.downloads[filename]) {
    this.downloads[filename] = new Promise((resolve, reject) => {
      // console.log('downloading', filename)
      var request = hh.get(filename, (response) => {
        var body = ''
        response.on('data', (chunk) => {
          body += chunk.toString()
        })
        response.on('error', reject)
        response.on('end', () => {
          this.files[filename].body = body
          // console.log('filename', filename)
          // console.log('out', this.options.out)
          // console.log('[] map', this.options.map)
          return resolve(postcss([]).process(body, {
            from: filename,
            to: this.options.out,
            map: this.options.map === false
              ? false
              : {
                inline: this.options.map === true
              }
          })
            .then((result) => {
              this.files[filename].cache = result
              return result
            }))
        })
      })
      request.on('error', reject)
      request.end()
    })
  }
  return this.downloads[filename]
}

exports.Bundle.prototype.rebundle = function rebundle (next) {
  return exports.order(this.files, this.entry)
    .then((sorted) => {
      return Promise.all(sorted.map((file) => {
        // console.log('file', file.name)
        if (isURL(file.name)) {
          // console.log('URL!')
          return this.loadRemote(file.name, this.options)
        } else {
          // TODO replace only the real imports, not commented ones
          var prom = Promise.resolve()
          if (file.options.plugins) {
            prom = prom.then((val) => {
              return Promise.all(file.options.plugins.map(function (plugin) {
                return exports.resolve(file.name, plugin)
              }))
            }, logError('resolving plugins'))
          } else {
            prom = prom.then(() => {
              return []
            })
          }
          return prom
            .then((plugins) => {
              let processor = postcss([])
              // console.log('from', file.name)
              // console.log('to', this.options.out)
              // console.log('map', this.options.map)
              return processor.process(file.body.replace(importRE, ''), {
                from: file.name,
                to: this.options.out,
                map: this.options.map === false
                  ? false
                  : {
                    inline: this.options.map === true
                  }
              })
            }, logError('CSS -> AST'))
        }
      }))
        .then((results) => {
          var node
          for (let i = 0, len = results.length; i < len; i += 1) {
            if (!node) {
              node = results[i].root
            } else {
              node.append(results[i].root)
            }
          }
          var result = node.toResult({
            to: this.options.out,
            map: this.options.map === false
              ? false
              : {
                inline: this.options.map === true
              }
          })
          return postcss(this.options.plugins.map((plugin) => {
            return require(plugin)
          })).process(result, {
            to: this.options.out,
            map: this.options.map === false
              ? false
              : {
                inline: this.options.map === true
              }
          })
        }, logError('all CSS -> AST'))
        .then((finalResult) => {
          var files = [
            fs.writeFileAsync(this.options.out, finalResult.css, 'utf8')
          ]
          if (typeof this.options.map === 'string') {
            files.push(fs.writeFileAsync(this.options.map, finalResult.map, 'utf8'))
          }

          return Promise.all(files)
        }, logError('AST -> Result + plugins'))
        .then(() => {
          next()
        })
    }, (reason) => {
      // TODO Only ignore aborts
      if (!reason.message === 'NOENT') {
        console.error('sorting', reason.stack || reason)
      } else {
        // console.log('aborting')
      }
      return next()
    })
}

// TODO make this async to allow getting the real paths of dependencies
exports.order = function order (files, file, ordering) {
  var curr = files[file]

  // if (!curr) {
  //   // console.log('aborting, no', file)
  //   throw new Error('NOENT')
  // }

  if (!ordering) {
    ordering = {}
  }
  if (ordering[file]) {
    // console.log('skipping (cycle)')
    return Promise.resolve([])
  }
  ordering[file] = true

  var proms = []
  for (let i = 0, len = curr.deps.length; i < len; i += 1) {
    // console.log(file, 'dep', curr.deps[i])
    if (isURL(curr.deps[i])) {
      proms.push(order(files, curr.deps[i], ordering))
    } else {
      proms.push(exports.realpath(curr.name, curr.deps[i])
        .then((realpath) => {
          return order(files, realpath, ordering)
        }))
    }
  }
  return Promise.all(proms)
    .then((arrs) => {
      var arr = []
      for (let i = 0, len = arrs.length; i < len; i += 1) {
        arr = arr.concat(arrs[i])
      }
      if (curr.isCSS) {
        arr.push(curr)
      }
      delete ordering[file]
      return arr
    })
}

exports.resolve = function resolve (file, dep) {
  return new Promise(function (resolve, reject) {
    browserResolve(dep, { filename: file }, (err, resolvedPath) => {
      if (err) {
        reject(err)
      } else {
        resolve(resolvedPath)
      }
    })
  })
}

exports.realpath = function realpath (file, dep) {
  return exports.resolve(file, dep)
    .then((resolvedPath) => {
      return fs.realpathAsync(resolvedPath)
    })
}

exports.toRequire = function toRequire (item) {
  return `require('${item}')`
}