var assert = require('assert');
var mongoose = require('../../');

var Promise = global.Promise || require('bluebird');

describe('validation docs', function() {
  var db;
  var Schema = mongoose.Schema;

  before(function() {
    db = mongoose.createConnection('mongodb://localhost:27017/mongoose_test', {
      poolSize: 1
    });
  });

  after(function(done) {
    db.close(done);
  });

  /**
   * 如果你要使用验证，请注意一下几点：
   *
   * - 验证定义于 [SchemaType](./schematypes.html)
   * - 验证是一个[中间件](./middleware.html)。它默认作为 pre('save')` 钩子注册在 schema 上
   * - 你可以使用 `doc.validate(callback)` 或 `doc.validateSync()` 手动验证
   * - 验证器不对未定义的值运行，唯一例外是 [`required` 验证器](./api.html#schematype_SchemaType-required)
   * - 验证是异步递归的。当你调用 [Model#save](./api.html#model_Model-save)，子文档验证也会执行，出错的话 [Model#save](./api.html#model_Model-save) 回调会接收错误
   * - 验证是可定制的
   */

  it('验证', function(done) {
    var schema = new Schema({
      name: {
        type: String,
        required: true
      }
    });
    var Cat = db.model('Cat', schema);

    // This cat has no name :(
    var cat = new Cat();
    cat.save(function(error) {
      assert.equal(error.errors['name'].message,
        'Path `name` is required.');

      error = cat.validateSync();
      assert.equal(error.errors['name'].message,
        'Path `name` is required.');
      // acquit:ignore:start
      done();
      // acquit:ignore:end
    });
  });

  /**
   * Mongoose 有一些内建验证器。
   *
   * - 所有 [SchemaTypes](./schematypes.html) 都有内建 [required](./api.html#schematype_SchemaType-required) 验证器。required 验证器使用 [`checkRequired()` 函数](./api.html#schematype_SchemaType-checkRequired) 判定这个值是否满足 required 验证器
   * - [Numbers](./api.html#schema-number-js) 有 [min](./api.html#schema_number_SchemaNumber-min) 和 [max](./api.html#schema_number_SchemaNumber-max) 验证器.
   * - [Strings](./api.html#schema-string-js) 有 [enum](./api.html#schema_string_SchemaString-enum)、 [match](./api.html#schema_string_SchemaString-match)、 [maxlength](./api.html#schema_string_SchemaString-maxlength) 和 [minlength](./api.html#schema_string_SchemaString-minlength) 验证器
   *
   * 上面的链接提供了使用和错误处理相关的详细信息
   */

  it('内建 Validators', function(done) {
    var breakfastSchema = new Schema({
      eggs: {
        type: Number,
        min: [6, 'Too few eggs'],
        max: 12
      },
      bacon: {
        type: Number,
        required: [true, 'Why no bacon?']
      },
      drink: {
        type: String,
        enum: ['Coffee', 'Tea'],
        required: function() {
          return this.bacon > 3;
        }
      }
    });
    var Breakfast = db.model('Breakfast', breakfastSchema);

    var badBreakfast = new Breakfast({
      eggs: 2,
      bacon: 0,
      drink: 'Milk'
    });
    var error = badBreakfast.validateSync();
    assert.equal(error.errors['eggs'].message,
      'Too few eggs');
    assert.ok(!error.errors['bacon']);
    assert.equal(error.errors['drink'].message,
      '`Milk` is not a valid enum value for path `drink`.');

    badBreakfast.bacon = 5;
    badBreakfast.drink = null;

    error = badBreakfast.validateSync();
    assert.equal(error.errors['drink'].message, 'Path `drink` is required.');

    badBreakfast.bacon = null;
    error = badBreakfast.validateSync();
    assert.equal(error.errors['bacon'].message, 'Why no bacon?');
    // acquit:ignore:start
    done();
    // acquit:ignore:end
  });

  /**
   * 初学者常见的 `unique` 选项
   * *不是*验证器。这是构建 [MongoDB unique indexes](https://docs.mongodb.com/manual/core/index-unique/) 的辅助函数。
   * 详见 [FAQ](/docs/faq.html)。
   */

  it('`unique` 不是验证器', function(done) {
    var uniqueUsernameSchema = new Schema({
      username: {
        type: String,
        unique: true
      }
    });
    var U1 = db.model('U1', uniqueUsernameSchema);
    var U2 = db.model('U2', uniqueUsernameSchema);
    // acquit:ignore:start
    var remaining = 3;
    // acquit:ignore:end

    var dup = [{ username: 'Val' }, { username: 'Val' }];
    U1.create(dup, function(error) {
      // Race condition! This may save successfully, depending on whether
      // MongoDB built the index before writing the 2 docs.
      // acquit:ignore:start
      // Avoid ESLint errors
      error;
      --remaining || done();
      // acquit:ignore:end
    });

    // Need to wait for the index to finish building before saving,
    // otherwise unique constraints may be violated.
    U2.once('index', function(error) {
      assert.ifError(error);
      U2.create(dup, function(error) {
        // Will error, but will *not* be a mongoose validation error, it will be
        // a duplicate key error.
        assert.ok(error);
        assert.ok(!error.errors);
        assert.ok(error.message.indexOf('duplicate key error') !== -1);
        // acquit:ignore:start
        --remaining || done();
        // acquit:ignore:end
      });
    });

    // There's also a promise-based equivalent to the event emitter API.
    // The `init()` function is idempotent and returns a promise that
    // will resolve once indexes are done building;
    U2.init().then(function() {
      U2.create(dup, function(error) {
        // Will error, but will *not* be a mongoose validation error, it will be
        // a duplicate key error.
        assert.ok(error);
        assert.ok(!error.errors);
        assert.ok(error.message.indexOf('duplicate key error') !== -1);
        // acquit:ignore:start
        --remaining || done();
        // acquit:ignore:end
      });
    });
  });

  /**
   * 如果内建检验器不够用了，你可以定义满足自己需要的检验器
   *
   * 自定义检验器通过传入一个检验函数来定义，更多细节请看
   * [`SchemaType#validate()` API 文档](./api.html#schematype_SchemaType-validate)。
   */
  it('自定义验证器', function(done) {
    var userSchema = new Schema({
      phone: {
        type: String,
        validate: {
          validator: function(v) {
            return /\d{3}-\d{3}-\d{4}/.test(v);
          },
          message: '{VALUE} is not a valid phone number!'
        },
        required: [true, 'User phone number required']
      }
    });

    var User = db.model('user', userSchema);
    var user = new User();
    var error;

    user.phone = '555.0123';
    error = user.validateSync();
    assert.equal(error.errors['phone'].message,
      '555.0123 is not a valid phone number!');

    user.phone = '';
    error = user.validateSync();
    assert.equal(error.errors['phone'].message,
      'User phone number required');

    user.phone = '201-555-0123';
    // Validation succeeds! Phone number is defined
    // and fits `DDD-DDD-DDDD`
    error = user.validateSync();
    assert.equal(error, null);
    // acquit:ignore:start
    done();
    // acquit:ignore:end
  });

  /**
   * 自定义检验器可以是异步的。如果检验函数
   * 返回 promise (像 `async` 函数)， mongoose 将会等待该 promise 完成。
   * 如果你更喜欢使用回调函数，设置 `isAsync` 选项，
   * mongoose 会将回调函数作为验证函数的第二个参数。
   */
  it('异步自定义验证器', function(done) {
    var userSchema = new Schema({
      name: {
        type: String,
        // You can also make a validator async by returning a promise. If you
        // return a promise, do **not** specify the `isAsync` option.
        validate: function(v) {
          return new Promise(function(resolve, reject) {
            setTimeout(function() {
              resolve(false);
            }, 5);
          });
        }
      },
      phone: {
        type: String,
        validate: {
          isAsync: true,
          validator: function(v, cb) {
            setTimeout(function() {
              var phoneRegex = /\d{3}-\d{3}-\d{4}/;
              var msg = v + ' is not a valid phone number!';
              // 第一个参数是布尔值，代表验证结果
              // 第二个参数是报错信息
              cb(phoneRegex.test(v), msg);
            }, 5);
          },
          // 默认报错信息会被 `cb()` 第二个参数覆盖
          message: 'Default error message'
        },
        required: [true, 'User phone number required']
      }
    });

    var User = db.model('User', userSchema);
    var user = new User();
    var error;

    user.phone = '555.0123';
    user.name = 'test';
    user.validate(function(error) {
      assert.ok(error);
      assert.equal(error.errors['phone'].message,
        '555.0123 is not a valid phone number!');
      assert.equal(error.errors['name'].message,
        'Validator failed for path `name` with value `test`');
      // acquit:ignore:start
      done();
      // acquit:ignore:end
    });
  });

  /**
   * 验证失败返回的 err 包含一个 `ValidatorError` 对象。
   * 每一个 [ValidatorError](./api.html#error-validation-js) 都有 `kind`、`path`、
   * `value` 和 `message` 属性。
   * ValidatorError 也可能有 `reason` 属性，
   * 如果检验器抛出错误，这个属性会包含该错误原因。
   */

  it('验证错误', function(done) {
    var toySchema = new Schema({
      color: String,
      name: String
    });

    var validator = function(value) {
      return /red|white|gold/i.test(value);
    };
    toySchema.path('color').validate(validator,
      'Color `{VALUE}` not valid', 'Invalid color');
    toySchema.path('name').validate(function(v) {
      if (v !== 'Turbo Man') {
        throw new Error('Need to get a Turbo Man for Christmas');
      }
      return true;
    }, 'Name `{VALUE}` is not valid');

    var Toy = db.model('Toy', toySchema);

    var toy = new Toy({ color: 'Green', name: 'Power Ranger' });

    toy.save(function (err) {
      // `err` is a ValidationError object
      // `err.errors.color` is a ValidatorError object
      assert.equal(err.errors.color.message, 'Color `Green` not valid');
      assert.equal(err.errors.color.kind, 'Invalid color');
      assert.equal(err.errors.color.path, 'color');
      assert.equal(err.errors.color.value, 'Green');

      // mongoose 5 新特性，如果验证器抛错，
      // mongoose 会使用该错误信息。如果验证器返回 `false`，
      // mongoose 会使用 'Name `Power Ranger` is not valid'。
      assert.equal(err.errors.name.message,
        'Need to get a Turbo Man for Christmas');
      assert.equal(err.errors.name.value, 'Power Ranger');
      // If your validator threw an error, the `reason` property will contain
      // the original error thrown, including the original stack trace.
      assert.equal(err.errors.name.reason.message,
        'Need to get a Turbo Man for Christmas');

      assert.equal(err.name, 'ValidationError');
      // acquit:ignore:start
      done();
      // acquit:ignore:end
    });
  });

  /**
   * Defining validators on nested objects in mongoose is tricky, because
   * nested objects are not fully fledged paths.
   */

  it('嵌套对象中的 Required 检验器', function(done) {
    var personSchema = new Schema({
      name: {
        first: String,
        last: String
      }
    });

    assert.throws(function() {
      // 这里会报错，因为 'name' 不是“完整成熟的路径”
      personSchema.path('name').required(true);
    }, /Cannot.*'required'/);

    // 要让嵌套对象 required，要使用单独的嵌套 schema
    var nameSchema = new Schema({
      first: String,
      last: String
    });

    personSchema = new Schema({
      name: {
        type: nameSchema,
        required: true
      }
    });

    var Person = db.model('Person', personSchema);

    var person = new Person();
    var error = person.validateSync();
    assert.ok(error.errors['name']);
    // acquit:ignore:start
    done();
    // acquit:ignore:end
  });

  /**
   * 上例中，你学习了 document 的验证。Mongoose 还支持验证 
   * `update()` 和 `findOneAndUpdate()` 操作。
   * Update 验证器默认关闭，如需打开，请另外配置 `runValidators`。
   *
   * 注意：update 验证器默认关闭是因为里面有几个注意事项必须先了解。
   */
  it('Update 验证器', function(done) {
    var toySchema = new Schema({
      color: String,
      name: String
    });

    var Toy = db.model('Toys', toySchema);

    Toy.schema.path('color').validate(function (value) {
      return /blue|green|white|red|orange|periwinkle/i.test(value);
    }, 'Invalid color');

    var opts = { runValidators: true };
    Toy.update({}, { color: 'bacon' }, opts, function (err) {
      assert.equal(err.errors.color.message,
        'Invalid color');
      // acquit:ignore:start
      done();
      // acquit:ignore:end
    });
  });

  /**
   * update 验证器和 document 验证器有诸多不同。
   * 上面的颜色验证函数，`this` 指向验证中的 document 。
   * 然而 update 验证器运行时，被更新文档不一定存在于服务器内存，
   * 所以 `this` 值未定义。
   */

  it('Update 验证器与 `this`', function(done) {
    var toySchema = new Schema({
      color: String,
      name: String
    });

    toySchema.path('color').validate(function(value) {
      // When running in `validate()` or `validateSync()`, the
      // validator can access the document using `this`.
      // Does **not** work with update validators.
      if (this.name.toLowerCase().indexOf('red') !== -1) {
        return value !== 'red';
      }
      return true;
    });

    var Toy = db.model('ActionFigure', toySchema);

    var toy = new Toy({ color: 'red', name: 'Red Power Ranger' });
    var error = toy.validateSync();
    assert.ok(error.errors['color']);

    var update = { color: 'red', name: 'Red Power Ranger' };
    var opts = { runValidators: true };

    Toy.update({}, update, opts, function(error) {
      // The update validator throws an error:
      // "TypeError: Cannot read property 'toLowerCase' of undefined",
      // because `this` is **not** the document being updated when using
      // update validators
      assert.ok(error);
      // acquit:ignore:start
      done();
      // acquit:ignore:end
    });
  });

  /**
   * `context` 选项允许你把 update 验证器的 `this` 设置为 `query`。
   */

  it('`context` 选项', function(done) {
    // acquit:ignore:start
    var toySchema = new Schema({
      color: String,
      name: String
    });
    // acquit:ignore:end
    toySchema.path('color').validate(function(value) {
      // When running update validators with the `context` option set to
      // 'query', `this` refers to the query object.
      if (this.getUpdate().$set.name.toLowerCase().indexOf('red') !== -1) {
        return value === 'red';
      }
      return true;
    });

    var Toy = db.model('Figure', toySchema);

    var update = { color: 'blue', name: 'Red Power Ranger' };
    // Note the context option
    var opts = { runValidators: true, context: 'query' };

    Toy.update({}, update, opts, function(error) {
      assert.ok(error.errors['color']);
      // acquit:ignore:start
      done();
      // acquit:ignore:end
    });
  });

  /**
   * 另一个关键不同点是 update 验证器只运行于更新的字段。
   * 下例中，因为 'name' 在更新操作未被指定，所以此次更新操作成功。
   *
   * 使用 update 验证器的时候， `required` 验证器**只会**在你对某个字段显式使用 `$unset` 才会触发。
   */

  it('Update 验证器字段路径', function(done) {
    // acquit:ignore:start
    var outstanding = 2;
    // acquit:ignore:end
    var kittenSchema = new Schema({
      name: { type: String, required: true },
      age: Number
    });

    var Kitten = db.model('Kitten', kittenSchema);

    var update = { color: 'blue' };
    var opts = { runValidators: true };
    Kitten.update({}, update, opts, function(err) {
      // 即使 'name' 没有指定也操作成功了
      // acquit:ignore:start
      --outstanding || done();
      // acquit:ignore:end
    });

    var unset = { $unset: { name: 1 } };
    Kitten.update({}, unset, opts, function(err) {
      // 'name' required， 操作失败
      assert.ok(err);
      assert.ok(err.errors['name']);
      // acquit:ignore:start
      --outstanding || done();
      // acquit:ignore:end
    });
  });

  /**
   * 最后要注意的是：update 验证器**只**运行于下列更新操作：
   *
   * - `$set`
   * - `$unset`
   * - `$push` (>= 4.8.0)
   * - `$addToSet` (>= 4.8.0)
   * - `$pull` (>= 4.12.0)
   * - `$pullAll` (>= 4.12.0)
   *
   * For instance, the below update will succeed, regardless of the value of
   * `number`, because update validators ignore `$inc`. Also, `$push`,
   * `$addToSet`, `$pull`, and `$pullAll` validation does **not** run any
   * validation on the array itself, only individual elements of the array.
   */

  it('Update 验证器只运行于指定字段路径', function(done) {
    var testSchema = new Schema({
      number: { type: Number, max: 0 },
      arr: [{ message: { type: String, maxlength: 10 } }]
    });

    // Update validators won't check this, so you can still `$push` 2 elements
    // onto the array, so long as they don't have a `message` that's too long.
    testSchema.path('arr').validate(function(v) {
      return v.length < 2;
    });

    var Test = db.model('Test', testSchema);

    var update = { $inc: { number: 1 } };
    var opts = { runValidators: true };
    Test.update({}, update, opts, function(error) {
      // There will never be a validation error here
      update = { $push: [{ message: 'hello' }, { message: 'world' }] };
      Test.update({}, update, opts, function(error) {
        // This will never error either even though the array will have at
        // least 2 elements.
        // acquit:ignore:start
        assert.ifError(error);
        done();
        // acquit:ignore:end
      });
    });
  });

  /**
   * 4.8.0 新特性： update 验证器也运行于 `$push` 和 `$addToSet`
   */

  it('$push 和 $addToSet', function(done) {
    var testSchema = new Schema({
      numbers: [{ type: Number, max: 0 }],
      docs: [{
        name: { type: String, required: true }
      }]
    });

    var Test = db.model('TestPush', testSchema);

    var update = {
      $push: {
        numbers: 1,
        docs: { name: null }
      }
    };
    var opts = { runValidators: true };
    Test.update({}, update, opts, function(error) {
      assert.ok(error.errors['numbers']);
      assert.ok(error.errors['docs']);
      // acquit:ignore:start
      done();
      // acquit:ignore:end
    });
  });
});
