'use strict';

/**
 * Module dependencies.
 */

Error.stackTraceLimit = 10;

const Server = require('mongodb-topology-manager').Server;
const mongoose = require('../');
const Collection = mongoose.Collection;
const assert = require('power-assert');

let server;

if (process.env.D === '1') {
  mongoose.set('debug', true);
}

/**
 * Override all Collection related queries to keep count
 */

[
  'createIndex',
  'ensureIndex',
  'findAndModify',
  'findOne',
  'find',
  'insert',
  'save',
  'update',
  'remove',
  'count',
  'distinct',
  'isCapped',
  'options'
].forEach(function(method) {
  var oldMethod = Collection.prototype[method];

  Collection.prototype[method] = function() {
    return oldMethod.apply(this, arguments);
  };
});

/**
 * Override Collection#onOpen to keep track of connections
 */

var oldOnOpen = Collection.prototype.onOpen;

Collection.prototype.onOpen = function() {
  return oldOnOpen.apply(this, arguments);
};

/**
 * Override Collection#onClose to keep track of disconnections
 */

var oldOnClose = Collection.prototype.onClose;

Collection.prototype.onClose = function() {
  return oldOnClose.apply(this, arguments);
};

/**
 * Create a connection to the test database.
 * You can set the environmental variable MONGOOSE_TEST_URI to override this.
 *
 * @api private
 */

module.exports = function(options) {
  options || (options = {});
  var uri;

  if (options.uri) {
    uri = options.uri;
    delete options.uri;
  } else {
    uri = module.exports.uri;
  }

  var noErrorListener = !!options.noErrorListener;
  delete options.noErrorListener;

  var conn = mongoose.createConnection(uri, options);

  if (noErrorListener) {
    return conn;
  }

  conn.on('error', function(err) {
    assert.ok(err);
  });

  return conn;
};

/*!
 * testing uri
 */

module.exports.uri = 'mongodb://localhost:27017/mongoose_test';

/**
 * expose mongoose
 */

module.exports.mongoose = mongoose;

/**
 * expose mongod version helper
 */

module.exports.mongodVersion = function(cb) {
  var db = module.exports();
  db.on('error', cb);

  db.on('open', function() {
    var admin = db.db.admin();
    admin.serverStatus(function(err, info) {
      if (err) {
        return cb(err);
      }
      var version = info.version.split('.').map(function(n) {
        return parseInt(n, 10);
      });
      db.close(function() {
        cb(null, version);
      });
    });
  });
};

function dropDBs(done) {
  var db = module.exports({ noErrorListener: true });
  db.once('open', function() {
    // drop the default test database
    db.db.dropDatabase(function() {
      done();
    });
  });
}

before(function() {
  return server.purge();
});

after(function() {
  this.timeout(15000);

  return server.stop();
});

before(function(done) {
  this.timeout(10 * 1000);
  dropDBs(done);
});

module.exports.server = server = new Server('mongod', {
  port: 27000,
  dbpath: './data/db/27000',
  storageEngine: 'mmapv1'
});

beforeEach(function() {
  if (this.currentTest) {
    global.CURRENT_TEST = this.currentTest.title;
  } else {
    global.CURRENT_TEST = 'N/A';
  }
});

process.on('unhandledRejection', function(error) {
  console.error(`unhandledRejection in "${global.CURRENT_TEST}":`, error.stack);
});
