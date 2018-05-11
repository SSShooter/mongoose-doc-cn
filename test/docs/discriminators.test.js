'use strict';

var assert = require('power-assert');
var async = require('async');
var mongoose = require('../../');

var Schema = mongoose.Schema;

describe('discriminator docs', function () {
  var Event;
  var ClickedLinkEvent;
  var SignedUpEvent;
  var db;

  before(function (done) {
    db = mongoose.createConnection('mongodb://localhost:27017/mongoose_test');

    var eventSchema = new mongoose.Schema({time: Date});
    Event = db.model('_event', eventSchema);

    ClickedLinkEvent = Event.discriminator('ClickedLink',
      new mongoose.Schema({url: String}));

    SignedUpEvent = Event.discriminator('SignedUp',
      new mongoose.Schema({username: String}));

    done();
  });

  after(function (done) {
    db.close(done);
  });

  beforeEach(function (done) {
    Event.remove({}, done);
  });

  /**
   * [Discriminator](/docs/api.html#discriminator_discriminator) 是一种 schema 继承机制。
   * 他允许你在相同的底层 MongoDB collection 上
   * 使用部分重叠的 schema 建立多个 model。
   *
   * 假设你要在单个 collection 中记录多种 event，
   * 每个 event 都有时间戳字段，但是 click 事件还有 URL 字段，
   * 这时你可以用 `model.discriminator()` 实现上述要求。
   * 此函数接受 2 个参数，model 名称和 discriminator schema，
   * 返回的 model 结合了原 model 的 schema 和 discriminator schema。
   */
  it('`model.discriminator()` 函数', function (done) {
    var options = {discriminatorKey: 'kind'};

    var eventSchema = new mongoose.Schema({time: Date}, options);
    var Event = mongoose.model('Event', eventSchema);

    // ClickedLinkEvent 是一个有 URL 的特别 event
    var ClickedLinkEvent = Event.discriminator('ClickedLink',
      new mongoose.Schema({url: String}, options));

    // 当你创建通用 event，他将没有 URL 字段...
    var genericEvent = new Event({time: Date.now(), url: 'google.com'});
    assert.ok(!genericEvent.url);

    // 但是 ClickedLinkEvent 可以有
    var clickedEvent =
      new ClickedLinkEvent({time: Date.now(), url: 'google.com'});
    assert.ok(clickedEvent.url);

    // acquit:ignore:start
    done();
    // acquit:ignore:end
  });

  /**
   * 现在假设你要创建另一个 discriminator，记录用户注册 event。
   * `SignedUpEvent` 实例将跟 通用 events 和 `ClickedLinkEvent` 实例
   * 一样储存在同一个 collection。
   */
  it('Discriminator 储存在 Event model 的 collection', function (done) {
    var event1 = new Event({time: Date.now()});
    var event2 = new ClickedLinkEvent({time: Date.now(), url: 'google.com'});
    var event3 = new SignedUpEvent({time: Date.now(), user: 'testuser'});

    var save = function (doc, callback) {
      doc.save(function (error, doc) {
        callback(error, doc);
      });
    };

    async.map([event1, event2, event3], save, function (error) {
      // acquit:ignore:start
      assert.ifError(error);
      // acquit:ignore:end

      Event.count({}, function (error, count) {
        // acquit:ignore:start
        assert.ifError(error);
        // acquit:ignore:end
        assert.equal(count, 3);
        // acquit:ignore:start
        done();
        // acquit:ignore:end
      });
    });
  });

  /** 
   * Mongoose 通过 'discriminator key' 识别两个不同的 discriminator，
   * 这个值默认是 `__t` 。Mongoose 自动在你的 schema 添加 `__t` 字段，
   * 记录你的 document 是哪个 discriminator 的实例。
   */
  it('Discriminator keys', function (done) {
    var event1 = new Event({time: Date.now()});
    var event2 = new ClickedLinkEvent({time: Date.now(), url: 'google.com'});
    var event3 = new SignedUpEvent({time: Date.now(), user: 'testuser'});

    assert.ok(!event1.__t);
    assert.equal(event2.__t, 'ClickedLink');
    assert.equal(event3.__t, 'SignedUp');

    // acquit:ignore:start
    done();
    // acquit:ignore:end
  });

  /**
   * Discriminator model 的特别之处在于：他们会把 discriminator key 附到
   * query 上。换句话说，`find()`, `count()`, `aggregate()` 等方法
   * 都能适配 discriminators。
   */
  it('Discriminator 在查询中添加 discriminator key', function (done) {
    var event1 = new Event({time: Date.now()});
    var event2 = new ClickedLinkEvent({time: Date.now(), url: 'google.com'});
    var event3 = new SignedUpEvent({time: Date.now(), user: 'testuser'});

    var save = function (doc, callback) {
      doc.save(function (error, doc) {
        callback(error, doc);
      });
    };

    async.map([event1, event2, event3], save, function (error) {
      // acquit:ignore:start
      assert.ifError(error);
      // acquit:ignore:end

      ClickedLinkEvent.find({}, function (error, docs) {
        // acquit:ignore:start
        assert.ifError(error);
        // acquit:ignore:end
        assert.equal(docs.length, 1);
        assert.equal(docs[0]._id.toString(), event2._id.toString());
        assert.equal(docs[0].url, 'google.com');
        // acquit:ignore:start
        done();
        // acquit:ignore:end
      });
    });
  });

  /**
   * Discriminator 会继承他的基础 schema 的 pre 和 post 中间件。
   * 不过，你也可以为 discriminator 添加中间件，这不回影响到基础 schema。
   */
  it('Discriminator 复制 pre / post 钩子', function (done) {
    var options = {discriminatorKey: 'kind'};

    var eventSchema = new mongoose.Schema({time: Date}, options);
    var eventSchemaCalls = 0;
    eventSchema.pre('validate', function (next) {
      ++eventSchemaCalls;
      next();
    });
    var Event = mongoose.model('GenericEvent', eventSchema);

    var clickedLinkSchema = new mongoose.Schema({url: String}, options);
    var clickedSchemaCalls = 0;
    clickedLinkSchema.pre('validate', function (next) {
      ++clickedSchemaCalls;
      next();
    });
    var ClickedLinkEvent = Event.discriminator('ClickedLinkEvent',
      clickedLinkSchema);

    var event1 = new ClickedLinkEvent();
    event1.validate(function() {
      assert.equal(eventSchemaCalls, 1);
      assert.equal(clickedSchemaCalls, 1);

      var generic = new Event();
      generic.validate(function() {
        assert.equal(eventSchemaCalls, 2);
        assert.equal(clickedSchemaCalls, 1);
        // acquit:ignore:start
        done();
        // acquit:ignore:end
      });
    });
  });

  /**
   * Discriminator 的字段是基础 schema 加 discriminator schema ，
   * 并且以 discriminator schema 的字段优先。
   * 但有一个例外，`_id` 字段。
   *
   * You can work around this by setting the `_id` option to false in the
   * discriminator schema as shown below.
   */
  it('处理自定义 _id 字段', function (done) {
    var options = {discriminatorKey: 'kind'};

    // 基础 schema 有字符串格式的 `_id` 字段和 Data 格式的 `time` 字段...
    var eventSchema = new mongoose.Schema({_id: String, time: Date},
      options);
    var Event = mongoose.model('BaseEvent', eventSchema);

    var clickedLinkSchema = new mongoose.Schema({
      url: String,
      time: String
    }, options);
    // 但是 Discriminator schema 有字符串格式的 `time`，并且有
    // 隐式添加的 ObjectId 格式的 `_id`
    assert.ok(clickedLinkSchema.path('_id'));
    assert.equal(clickedLinkSchema.path('_id').instance, 'ObjectID');
    var ClickedLinkEvent = Event.discriminator('ChildEventBad',
      clickedLinkSchema);

    var event1 = new ClickedLinkEvent({ _id: 'custom id', time: '4pm' });
    // 问题来了，clickedLinkSchema 重写了 `time` 路径，但是**没有**
    // 重写 `_id` 路径，因为已经隐式添加（没看懂）
    assert.ok(typeof event1._id === 'string');
    assert.ok(typeof event1.time === 'string');

    // acquit:ignore:start
    done();
    // acquit:ignore:end
  });

  /**
   * 当你使用 `Model.create()`，Mongoose 会自动帮你适配 discriminator key ~
   */
  it('discriminator 与 `Model.create()`', function(done) {
    var Schema = mongoose.Schema;
    var shapeSchema = new Schema({
      name: String
    }, { discriminatorKey: 'kind' });

    var Shape = db.model('Shape', shapeSchema);

    var Circle = Shape.discriminator('Circle',
      new Schema({ radius: Number }));
    var Square = Shape.discriminator('Square',
      new Schema({ side: Number }));

    var shapes = [
      { name: 'Test' },
      { kind: 'Circle', radius: 5 },
      { kind: 'Square', side: 10 }
    ];
    Shape.create(shapes, function(error, shapes) {
      assert.ifError(error);
      // 重点看这里
      assert.ok(shapes[0] instanceof Shape);
      assert.ok(shapes[1] instanceof Circle);
      assert.equal(shapes[1].radius, 5);
      assert.ok(shapes[2] instanceof Square);
      assert.equal(shapes[2].side, 10);
      // acquit:ignore:start
      done();
      // acquit:ignore:end
    });
  });

  /**
   * 你也可以为嵌套文档数组定义 discriminator。
   * 嵌套 discriminator 的特点是：不同 discriminator
   * 类型储存在相同的文档而不是同一个 mongoDB collection。
   * 换句话说，嵌套 discriminator 让你
   * 在同一个数组储存符合不同 schema 的子文档。
   *
   * 最佳实践：确保你声明了钩子再使用他们。
   * 你**不应当**在调用 `discriminator()` 之后调用 `pre()` 或 `post()`
   */
  it('数组中的嵌套 discriminator', function(done) {
    var eventSchema = new Schema({ message: String },
      { discriminatorKey: 'kind', _id: false });

    var batchSchema = new Schema({ events: [eventSchema] });

    // `batchSchema.path('events')` gets the mongoose `DocumentArray`
    var docArray = batchSchema.path('events');

    // 这个 `events` 数组可以包含 2 种不同的 event 类型，
    // 'clicked' event that requires an element id that was clicked...
    var clickedSchema = new Schema({
      element: {
        type: String,
        required: true
      }
    }, { _id: false });
    // 确定在调用 `discriminator()` **之前**
    // 对 `eventSchema` 和 `clickedSchema` 赋予钩子
    var Clicked = docArray.discriminator('Clicked', clickedSchema);

    // ... and a 'purchased' event that requires the product that was purchased.
    var Purchased = docArray.discriminator('Purchased', new Schema({
      product: {
        type: String,
        required: true
      }
    }, { _id: false }));

    var Batch = db.model('EventBatch', batchSchema);

    // Create a new batch of events with different kinds
    var batch = {
      events: [
        { kind: 'Clicked', element: '#hero', message: 'hello' },
        { kind: 'Purchased', product: 'action-figure-1', message: 'world' }
      ]
    };

    Batch.create(batch).
      then(function(doc) {
        assert.equal(doc.events.length, 2);

        assert.equal(doc.events[0].element, '#hero');
        assert.equal(doc.events[0].message, 'hello');
        assert.ok(doc.events[0] instanceof Clicked);

        assert.equal(doc.events[1].product, 'action-figure-1');
        assert.equal(doc.events[1].message, 'world');
        assert.ok(doc.events[1] instanceof Purchased);

        doc.events.push({ kind: 'Purchased', product: 'action-figure-2' });
        return doc.save();
      }).
      then(function(doc) {
        assert.equal(doc.events.length, 3);

        assert.equal(doc.events[2].product, 'action-figure-2');
        assert.ok(doc.events[2] instanceof Purchased);

        done();
      }).
      catch(done);
  });

  /**
   * 检索嵌套 discriminator
   */
  it('检索数组中的嵌套 discriminator', function(done) {
    var singleEventSchema = new Schema({ message: String },
      { discriminatorKey: 'kind', _id: false });

    var eventListSchema = new Schema({ events: [singleEventSchema] });

    var subEventSchema = new Schema({
       sub_events: [singleEventSchema]
    }, { _id: false });

    var SubEvent = subEventSchema.path('sub_events').discriminator('SubEvent', subEventSchema)
    eventListSchema.path('events').discriminator('SubEvent', subEventSchema);

    var Eventlist = db.model('EventList', eventListSchema);

    // Create a new batch of events with different kinds
    var list = {
      events: [
        { kind: 'SubEvent', sub_events: [{kind:'SubEvent', sub_events:[], message:'test1'}], message: 'hello' },
        { kind: 'SubEvent', sub_events: [{kind:'SubEvent', sub_events:[{kind:'SubEvent', sub_events:[], message:'test3'}], message:'test2'}], message: 'world' }
      ]
    };

    Eventlist.create(list).
      then(function(doc) {
        assert.equal(doc.events.length, 2);

        assert.equal(doc.events[0].sub_events[0].message, 'test1');
        assert.equal(doc.events[0].message, 'hello');
        assert.ok(doc.events[0].sub_events[0] instanceof SubEvent);

        assert.equal(doc.events[1].sub_events[0].sub_events[0].message, 'test3');
        assert.equal(doc.events[1].message, 'world');
        assert.ok(doc.events[1].sub_events[0].sub_events[0] instanceof SubEvent);

        doc.events.push({kind:'SubEvent', sub_events:[{kind:'SubEvent', sub_events:[], message:'test4'}], message:'pushed'});
        return doc.save();
      }).
      then(function(doc) {
        assert.equal(doc.events.length, 3);

        assert.equal(doc.events[2].message, 'pushed');
        assert.ok(doc.events[2].sub_events[0] instanceof SubEvent);

        done();
      }).
      catch(done);
  });
});
