var PromiseProvider = require('../../lib/promise_provider');
var assert = require('power-assert');
var mongoose = require('../../');

describe('promises docs', function () {
  var Band;
  var db;

  before(function (done) {
    db = mongoose.createConnection('mongodb://localhost:27017/mongoose_test');

    Band = db.model('band-promises', {name: String, members: [String]});

    done();
  });

  beforeEach(function (done) {
    Band.remove({}, done);
  });

  after(function (done) {
    db.close(done);
  });

  /**
   * Mongoose async operations, like `.save()` and queries, return
   * [ES6 promises](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise).
   * This means that you can do things like `MyModel.findOne({}).then()` and
   * `await MyModel.findOne({}).exec()` (if you're using [async/await](http://thecodebarbarian.com/80-20-guide-to-async-await-in-node.js.html).
   */
  it('Built-in Promises', function (done) {
    var gnr = new Band({
      name: "Guns N' Roses",
      members: ['Axl', 'Slash']
    });

    var promise = gnr.save();
    assert.ok(promise instanceof Promise);

    promise.then(function (doc) {
      assert.equal(doc.name, "Guns N' Roses");
      // acquit:ignore:start
      done();
      // acquit:ignore:end
    });
  });

  /**
   * Mongoose queries are **not** promises. However, they do have a `.then()`
   * function for `yield` and async/await. If you need
   * a fully-fledged promise, use the `.exec()` function.
   */
  it('Queries are not promises', function (done) {
    var query = Band.findOne({name: "Guns N' Roses"});
    assert.ok(!(query instanceof Promise));

    // acquit:ignore:start
    var outstanding = 2;
    // acquit:ignore:end

    // A query is not a fully-fledged promise, but it does have a `.then()`.
    query.then(function (doc) {
      // use doc
      // acquit:ignore:start
      assert.ok(!doc);
      --outstanding || done();
      // acquit:ignore:end
    });

    // `.exec()` gives you a fully-fledged promise
    var promise = query.exec();
    assert.ok(promise instanceof Promise);

    promise.then(function (doc) {
      // use doc
      // acquit:ignore:start
      assert.ok(!doc);
      --outstanding || done();
      // acquit:ignore:end
    });
  });

  /**
   * If you're an advanced user, you may want to plug in your own promise
   * library like [bluebird](https://www.npmjs.com/package/bluebird). Just set
   * `mongoose.Promise` to your favorite
   * ES6-style promise constructor and mongoose will use it.
   */
  it('Plugging in your own Promises Library', function (done) {
    // acquit:ignore:start
    if (!global.Promise) {
      return done();
    }
    // acquit:ignore:end
    var query = Band.findOne({name: "Guns N' Roses"});

    // Use bluebird
    mongoose.Promise = require('bluebird');
    assert.equal(query.exec().constructor, require('bluebird'));

    // Use q. Note that you **must** use `require('q').Promise`.
    mongoose.Promise = require('q').Promise;
    assert.ok(query.exec() instanceof require('q').makePromise);

    // acquit:ignore:start
    done();
    // acquit:ignore:end
  });

  /**
   * The `mongoose.Promise` property sets the promises mongoose uses. However,
   * this does **not** affect the underlying MongoDB driver. If you use the
   * underlying driver, for instance `Model.collection.db.insert()`, you
   * need to do a little extra work to change the underlying promises library.
   * Note that the below code assumes mongoose >= 4.4.4.
   */
  it('Promises for the MongoDB Driver', function (done) {
    // acquit:ignore:start
    if (!global.Promise) {
      return done();
    }
    // acquit:ignore:end
    var uri = 'mongodb://localhost:27017/mongoose_test';
    // Use bluebird
    var options = { promiseLibrary: require('bluebird') };
    var db = mongoose.createConnection(uri, options);

    Band = db.model('band-promises', { name: String });

    db.on('open', function() {
      assert.equal(Band.collection.findOne().constructor, require('bluebird'));
      // acquit:ignore:start
      done();
      // acquit:ignore:end
    });
  });
});
