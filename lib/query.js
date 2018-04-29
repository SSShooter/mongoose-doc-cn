/*!
 * Module dependencies.
 */

var CastError = require('./error/cast');
var ObjectParameterError = require('./error/objectParameter');
var QueryCursor = require('./cursor/QueryCursor');
var ReadPreference = require('./drivers').ReadPreference;
var cast = require('./cast');
var castUpdate = require('./services/query/castUpdate');
var hasDollarKeys = require('./services/query/hasDollarKeys');
var helpers = require('./queryhelpers');
var isInclusive = require('./services/projection/isInclusive');
var mquery = require('mquery');
var selectPopulatedFields = require('./services/query/selectPopulatedFields');
var setDefaultsOnInsert = require('./services/setDefaultsOnInsert');
var slice = require('sliced');
var updateValidators = require('./services/updateValidators');
var util = require('util');
var utils = require('./utils');

/**
 * Query 构造函数用来构建查询器，不过并不需要直接实例化 `Query` 对象，可以用 Model 的 [`Model.find()`](/docs/api.html#find_find) 这些函数。
 *
 * ####示例:
 *
 *     const query = MyModel.find(); // `query` 是 `Query` 的一个实例
 *     query.setOptions({ lean : true });
 *     query.collection(MyModel.collection);
 *     query.where('age').gte(21).exec(callback);
 *
 *     // 你也可以实例化一个 query，不过，除非你是个高级用户又有充分的理由，否则没有必要这么做。
 *     const query = new mongoose.Query();
 *
 * @param {Object} [options]
 * @param {Object} [model]
 * @param {Object} [conditions]
 * @param {Object} [collection] Mongoose collection
 * @api public
 */

function Query(conditions, options, model, collection) {
  // this stuff is for dealing with custom queries created by #toConstructor
  if (!this._mongooseOptions) {
    this._mongooseOptions = {};
  }
  options = options || {};

  // this is the case where we have a CustomQuery, we need to check if we got
  // options passed in, and if we did, merge them in
  var keys = Object.keys(options);
  for (var i = 0; i < keys.length; ++i) {
    var k = keys[i];
    this._mongooseOptions[k] = options[k];
  }

  if (collection) {
    this.mongooseCollection = collection;
  }

  if (model) {
    this.model = model;
    this.schema = model.schema;
  }

  // this is needed because map reduce returns a model that can be queried, but
  // all of the queries on said model should be lean
  if (this.model && this.model._mapreduce) {
    this.lean();
  }

  // inherit mquery
  mquery.call(this, this.mongooseCollection, options);

  if (conditions) {
    this.find(conditions);
  }

  this.options = this.options || {};
  if (this.schema != null && this.schema.options.collation != null) {
    this.options.collation = this.schema.options.collation;
  }
}

/*!
 * inherit mquery
 */

Query.prototype = new mquery;
Query.prototype.constructor = Query;
Query.base = mquery.prototype;

/**
 * Flag to opt out of using `$geoWithin`.
 *
 *     mongoose.Query.use$geoWithin = false;
 *
 * MongoDB 2.4 不再赞成使用 `$within`，而是用 `$geoWithin` 代替。Mongoose 默认使用 `$geoWithin`（对 $within 100%后向兼容）。
 * 你如果运行较低版本的 MongoDB，把这个标识置为 `false` 就能使 `within()` 继续有效。
 *
 * @see http://docs.mongodb.org/manual/reference/operator/geoWithin/
 * @default true
 * @property use$geoWithin
 * @memberOf Query
 * @receiver Query
 * @api public
 */

Query.use$geoWithin = mquery.use$geoWithin;

/**
 * 把当前 query 转换成自定义、可复用的 query 构造函数，保留所有参数（ arguments ）和选项（ options ）。
 *
 * ####示例
 *
 *     // 为 adventure movies 生成一个 query，并从复本集（ replica-set ）中的主节点读取数据，
 *     // 如果主节点宕机，则从第二节点读取。
 *     var query = Movie.find({ tags: 'adventure' }).read('primaryPreferred');
 *
 *     // 基于以上设置创建一个自定义 Query 构造函数
 *     var Adventure = query.toConstructor();
 *
 *     // Adventure 就成了 mongoose.Query 的子类，使用方式一致，并且已设置了默认的查询参数和选项。
 *     Adventure().exec(callback)
 *
 *     // 在之前的设置基础上进一步缩小查询结果集
 *     Adventure().where({ name: /^Life/ }).exec(callback);
 *
 *     // 由于 Adventure 是个独立的构造函数，我们也可以向其添加自定义的辅助方法（ helper methods ）
 *     // 和 getter 函数，并且不会影响到全局查询。
 *     Adventure.prototype.startsWith = function (prefix) {
 *       this.where({ name: new RegExp('^' + prefix) })
 *       return this;
 *     }
 *     Object.defineProperty(Adventure.prototype, 'highlyRated', {
 *       get: function () {
 *         this.where({ rating: { $gt: 4.5 }});
 *         return this;
 *       }
 *     })
 *     Adventure().highlyRated.startsWith('Life').exec(callback)
 *
 * 从版本3.7.3开始的新更能
 *
 * @return {Query} subclass-of-Query
 * @api public
 */

Query.prototype.toConstructor = function toConstructor() {
  var model = this.model;
  var coll = this.mongooseCollection;

  var CustomQuery = function(criteria, options) {
    if (!(this instanceof CustomQuery)) {
      return new CustomQuery(criteria, options);
    }
    this._mongooseOptions = utils.clone(p._mongooseOptions);
    Query.call(this, criteria, options || null, model, coll);
  };

  util.inherits(CustomQuery, Query);

  // set inherited defaults
  var p = CustomQuery.prototype;

  p.options = {};

  p.setOptions(this.options);

  p.op = this.op;
  p._conditions = utils.clone(this._conditions);
  p._fields = utils.clone(this._fields);
  p._update = utils.clone(this._update, {
    flattenDecimals: false
  });
  p._path = this._path;
  p._distinct = this._distinct;
  p._collection = this._collection;
  p._mongooseOptions = this._mongooseOptions;

  return CustomQuery;
};

/**
 * 指定一个传给 MongoDB query 的函数或表达式。
 *
 * ####示例
 *
 *     query.$where('this.comments.length === 10 || this.name.length === 5')
 *
 *     // or
 *
 *     query.$where(function () {
 *       return this.comments.length === 10 || this.name.length === 5;
 *     })
 *
 * ####注意：
 *
 * 只有当 MongoDB 其他操作符（如 `$lt`）不能表达你的查询条件时再使用 `$where`。
 * **使用之前一定要阅读它的所有[警告](http://docs.mongodb.org/manual/reference/operator/where/)**
 *
 * @see $where http://docs.mongodb.org/manual/reference/operator/where/
 * @method $where
 * @param {String|Function} js javascript string or function
 * @return {Query} this
 * @memberOf Query
 * @method $where
 * @api public
 */

/**
 * 在链式查询中指定一个 `path`。
 *
 * ####示例
 *
 *     // find写法：
 *     User.find({age: {$gte: 21, $lte: 65}}, callback);
 *
 *     // where 替换写法：
 *     User.where('age').gte(21).lte(65);
 *
 *     // 也可以传入 query condition
 *     User.find().where({ name: 'vonderful' })
 *
 *     // 链式写法
 *     User
 *     .where('age').gte(21).lte(65)
 *     .where('name', /^vonderful/i)
 *     .where('friends').slice(10)
 *     .exec(callback)
 *
 * @method where
 * @memberOf Query
 * @param {String|Object} [path]
 * @param {any} [val]
 * @return {Query} this
 * @api public
 */

Query.prototype.slice = function() {
  if (arguments.length === 0) {
    return this;
  }

  this._validate('slice');

  var path;
  var val;

  if (arguments.length === 1) {
    var arg = arguments[0];
    if (typeof arg === 'object' && !Array.isArray(arg)) {
      var keys = Object.keys(arg);
      var numKeys = keys.length;
      for (var i = 0; i < numKeys; ++i) {
        this.slice(keys[i], arg[keys[i]]);
      }
      return this;
    }
    this._ensurePath('slice');
    path = this._path;
    val = arguments[0];
  } else if (arguments.length === 2) {
    if ('number' === typeof arguments[0]) {
      this._ensurePath('slice');
      path = this._path;
      val = slice(arguments);
    } else {
      path = arguments[0];
      val = arguments[1];
    }
  } else if (arguments.length === 3) {
    path = arguments[0];
    val = slice(arguments, 1);
  }

  var p = {};
  p[path] = { $slice: val };
  this.select(p);

  return this;
};


/**
 * 指定一个值，跟 `where()` 指定的路径做等值比较。
 *
 * ####示例
 *
 *     User.where('age').equals(49);
 *
 *     // 等效于
 *
 *     User.where('age', 49);
 *
 * @method equals
 * @memberOf Query
 * @param {Object} val
 * @return {Query} this
 * @api public
 */

/**
 * 为 `$or` 条件指定参数。
 *
 * ####示例
 *
 *     query.or([{ color: 'red' }, { status: 'emergency' }])
 *
 * @see $or http://docs.mongodb.org/manual/reference/operator/or/
 * @method or
 * @memberOf Query
 * @param {Array} array array of conditions
 * @return {Query} this
 * @api public
 */

/**
 * 为 `$nor` 条件指定参数。
 *
 * ####示例
 *
 *     query.nor([{ color: 'green' }, { status: 'ok' }])
 *
 * @see $nor http://docs.mongodb.org/manual/reference/operator/nor/
 * @method nor
 * @memberOf Query
 * @param {Array} array array of conditions
 * @return {Query} this
 * @api public
 */

/**
 * 为 `$and` 条件指定参数。
 *
 * ####示例
 *
 *     query.and([{ color: 'green' }, { status: 'ok' }])
 *
 * @method and
 * @memberOf Query
 * @see $and http://docs.mongodb.org/manual/reference/operator/and/
 * @param {Array} array array of conditions
 * @return {Query} this
 * @api public
 */

/**
 * 指定一个 $gt 查询条件。
 *
 * 如果只传入一个参数，则对最后的 `where()` 路径生效。
 *
 * ####示例
 *
 *     Thing.find().where('age').gt(21)
 *
 *     // or
 *     Thing.find().gt('age', 21)
 *
 * @method gt
 * @memberOf Query
 * @param {String} [path]
 * @param {Number} val
 * @see $gt http://docs.mongodb.org/manual/reference/operator/gt/
 * @api public
 */

/**
 * 指定一个 $gte 查询条件。
 *
 * 如果只传入一个参数，则对最后的 `where()` 路径生效。
 *
 * @method gte
 * @memberOf Query
 * @param {String} [path]
 * @param {Number} val
 * @see $gte http://docs.mongodb.org/manual/reference/operator/gte/
 * @api public
 */

/**
 * 指定一个 $lt 查询条件。
 *
 * 如果只传入一个参数，则对最后的 `where()` 路径生效。
 *
 * @method lt
 * @memberOf Query
 * @param {String} [path]
 * @param {Number} val
 * @see $lt http://docs.mongodb.org/manual/reference/operator/lt/
 * @api public
 */

/**
 * 指定一个 $lte 查询条件。
 *
 * 如果只传入一个参数，则对最后的 `where()` 路径生效。
 *
 * @method lte
 * @see $lte http://docs.mongodb.org/manual/reference/operator/lte/
 * @memberOf Query
 * @param {String} [path]
 * @param {Number} val
 * @api public
 */

/**
 * 指定一个 $ne 查询条件。
 *
 * 如果只传入一个参数，则对最后的 `where()` 路径生效。
 *
 * @see $ne http://docs.mongodb.org/manual/reference/operator/ne/
 * @method ne
 * @memberOf Query
 * @param {String} [path]
 * @param {Number} val
 * @api public
 */

/**
 * 指定一个 $in 查询条件。
 *
 * 如果只传入一个参数，则对最后的 `where()` 路径生效。
 *
 * @see $in http://docs.mongodb.org/manual/reference/operator/in/
 * @method in
 * @memberOf Query
 * @param {String} [path]
 * @param {Number} val
 * @api public
 */

/**
 * 指定一个 $nin 查询条件。
 *
 * 如果只传入一个参数，则对最后的 `where()` 路径生效。
 *
 * @see $nin http://docs.mongodb.org/manual/reference/operator/nin/
 * @method nin
 * @memberOf Query
 * @param {String} [path]
 * @param {Number} val
 * @api public
 */

/**
 * 指定一个 $all 查询条件。
 *
 * 如果只传入一个参数，则对最后的 `where()` 路径生效。
 *
 * @see $all http://docs.mongodb.org/manual/reference/operator/all/
 * @method all
 * @memberOf Query
 * @param {String} [path]
 * @param {Number} val
 * @api public
 */

/**
 * 指定一个 $size 查询条件。
 *
 * 如果只传入一个参数，则对最后的 `where()` 路径生效。
 *
 * ####示例
 *
 *     MyModel.where('tags').size(0).exec(function (err, docs) {
 *       if (err) return handleError(err);
 *
 *       assert(Array.isArray(docs));
 *       console.log('documents with 0 tags', docs);
 *     })
 *
 * @see $size http://docs.mongodb.org/manual/reference/operator/size/
 * @method size
 * @memberOf Query
 * @param {String} [path]
 * @param {Number} val
 * @api public
 */

/**
 * 指定一个 $regex 查询条件。
 *
 * 如果只传入一个参数，则对最后的 `where()` 路径生效。
 *
 * @see $regex http://docs.mongodb.org/manual/reference/operator/regex/
 * @method regex
 * @memberOf Query
 * @param {String} [path]
 * @param {String|RegExp} val
 * @api public
 */

/**
 * 指定一个 $maxDistance 查询条件。
 *
 * 如果只传入一个参数，则对最后的 `where()` 路径生效。
 *
 * @see $maxDistance http://docs.mongodb.org/manual/reference/operator/maxDistance/
 * @method maxDistance
 * @memberOf Query
 * @param {String} [path]
 * @param {Number} val
 * @api public
 */

/**
 * 指定一个 `$mod` 条件，对文档的过滤规则：属性 `path` 是个数值，且对除数（ `divisor` ）取模，余数等于 `remainder`
 *
 * ####示例
 *
 *     // products 中 inventory 是奇数的
 *     Product.find().mod('inventory', [2, 1]);
 *     Product.find().where('inventory').mod([2, 1]);
 *     // 这种语法有点儿奇怪，但也支持。
 *     Product.find().where('inventory').mod(2, 1);
 *
 * @method mod
 * @memberOf Query
 * @param {String} [path]
 * @param {Array} val must be of length 2, first element is `divisor`, 2nd element is `remainder`.
 * @return {Query} this
 * @see $mod http://docs.mongodb.org/manual/reference/operator/mod/
 * @api public
 */

Query.prototype.mod = function() {
  var val;
  var path;

  if (arguments.length === 1) {
    this._ensurePath('mod');
    val = arguments[0];
    path = this._path;
  } else if (arguments.length === 2 && !Array.isArray(arguments[1])) {
    this._ensurePath('mod');
    val = slice(arguments);
    path = this._path;
  } else if (arguments.length === 3) {
    val = slice(arguments, 1);
    path = arguments[0];
  } else {
    val = arguments[1];
    path = arguments[0];
  }

  var conds = this._conditions[path] || (this._conditions[path] = {});
  conds.$mod = val;
  return this;
};

/**
 * 指定一个 `$exists` 查询条件。
 *
 * ####示例
 *
 *     // { name: { $exists: true }}
 *     // 如果要 `有值` 的字段，true 是默认值，可以省略
 *     Thing.where('name').exists()
 *     Thing.where('name').exists(true)
 *     Thing.find().exists('name')
 *
 *     // { name: { $exists: false }}
 *     // 如果要 `无值` 的字段，false 必须显式指定
 *     Thing.where('name').exists(false);
 *     Thing.find().exists('name', false);
 *
 * @method exists
 * @memberOf Query
 * @param {String} [path]
 * @param {Number} val
 * @return {Query} this
 * @see $exists http://docs.mongodb.org/manual/reference/operator/exists/
 * @api public
 */

/**
 * 指定一个 `$elemMatch` 查询条件。
 *
 * ####示例
 *
 *     query.elemMatch('comment', { author: 'autobot', votes: {$gte: 5}})
 *
 *     query.where('comment').elemMatch({ author: 'autobot', votes: {$gte: 5}})
 *
 *     query.elemMatch('comment', function (elem) {
 *       elem.where('author').equals('autobot');
 *       elem.where('votes').gte(5);
 *     })
 *
 *     query.where('comment').elemMatch(function (elem) {
 *       elem.where({ author: 'autobot' });
 *       elem.where('votes').gte(5);
 *     })
 *
 * @method elemMatch
 * @memberOf Query
 * @param {String|Object|Function} path
 * @param {Object|Function} criteria
 * @return {Query} this
 * @see $elemMatch http://docs.mongodb.org/manual/reference/operator/elemMatch/
 * @api public
 */

/**
 * 给 地理空间（ geo-spatial ）查询 `$within`、`$geoWithin` 指定参数
 *
 * ####示例
 *
 *     query.where(path).within().box()
 *     query.where(path).within().circle()
 *     query.where(path).within().geometry()
 *
 *     query.where('loc').within({ center: [50,50], radius: 10, unique: true, spherical: true });
 *     query.where('loc').within({ box: [[40.73, -73.9], [40.7, -73.988]] });
 *     query.where('loc').within({ polygon: [[],[],[],[]] });
 *
 *     query.where('loc').within([], [], []) // polygon
 *     query.where('loc').within([], []) // box
 *     query.where('loc').within({ type: 'LineString', coordinates: [...] }); // geometry
 *
 * **必须**随 `where()` 一起使用。
 *
 * ####注意:
 *
 * 从 Mongoose 3.7 开始，查询中默认使用 `$geoWithin`。想改变这种做法，查看 [Query.use$geoWithin](#query_Query-use%2524geoWithin)。
 *
 * ####注意:
 *
 * 在 Mongoose 3.7 中，`within` 由 getter 改变成了函数。如果你需要旧语法，查看 [这里](https://github.com/ebensing/mongoose-within)。
 *
 * @method within
 * @see $polygon http://docs.mongodb.org/manual/reference/operator/polygon/
 * @see $box http://docs.mongodb.org/manual/reference/operator/box/
 * @see $geometry http://docs.mongodb.org/manual/reference/operator/geometry/
 * @see $center http://docs.mongodb.org/manual/reference/operator/center/
 * @see $centerSphere http://docs.mongodb.org/manual/reference/operator/centerSphere/
 * @memberOf Query
 * @return {Query} this
 * @api public
 */

/**
 * 对数组字段做切片映射（ $slice projection）。
 *
 * ####示例
 *
 *     query.slice('comments', 5)
 *     query.slice('comments', -5)
 *     query.slice('comments', [10, 5])
 *     query.where('comments').slice(5)
 *     query.where('comments').slice([-10, 5])
 *
 * @method slice
 * @memberOf Query
 * @param {String} [path]
 * @param {Number} val number/range of elements to slice
 * @return {Query} this
 * @see mongodb http://www.mongodb.org/display/DOCS/Retrieving+a+Subset+of+Fields#RetrievingaSubsetofFields-RetrievingaSubrangeofArrayElements
 * @see $slice http://docs.mongodb.org/manual/reference/projection/slice/#prj._S_slice
 * @api public
 */

/**
 * 指定查询结果的最大条数。
 *
 * ####示例
 *
 *     query.limit(20)
 *
 * ####注意
 *
 * 不能和 `distinct()` 一起使用
 *
 * @method limit
 * @memberOf Query
 * @param {Number} val
 * @api public
 */

/**
 * 指定跳过的文档条数。
 *
 * ####示例
 *
 *     query.skip(100).limit(20)
 *
 * ####注意
 *
 * 不能和 `distinct()` 一起使用
 *
 * @method skip
 * @memberOf Query
 * @param {Number} val
 * @see cursor.skip http://docs.mongodb.org/manual/reference/method/cursor.skip/
 * @api public
 */

/**
 * 指定 maxScan 选项
 *
 * ####示例
 *
 *     query.maxScan(100)
 *
 * ####注意
 *
 * 不能和 `distinct()` 一起使用
 *
 * @method maxScan
 * @memberOf Query
 * @param {Number} val
 * @see maxScan http://docs.mongodb.org/manual/reference/operator/maxScan/
 * @api public
 */

/**
 * 指定 batchSize 选项
 *
 * ####示例
 *
 *     query.batchSize(100)
 *
 * ####注意
 *
 * 不能和 `distinct()` 一起使用
 *
 * @method batchSize
 * @memberOf Query
 * @param {Number} val
 * @see batchSize http://docs.mongodb.org/manual/reference/method/cursor.batchSize/
 * @api public
 */

/**
 * 指定 `comment` 选项
 *
 * ####示例
 *
 *     query.comment('login query')
 *
 * ####注意
 *
 * 不能和 `distinct()` 一起使用
 *
 * @method comment
 * @memberOf Query
 * @param {Number} val
 * @see comment http://docs.mongodb.org/manual/reference/operator/comment/
 * @api public
 */

/**
 * 把当前 query 指定成快照（ `snapshot` ）query
 *
 * ####示例
 *
 *     query.snapshot() // true
 *     query.snapshot(true)
 *     query.snapshot(false)
 *
 * ####注意
 *
 * 不能和 `distinct()` 一起使用
 *
 * @method snapshot
 * @memberOf Query
 * @see snapshot http://docs.mongodb.org/manual/reference/operator/snapshot/
 * @return {Query} this
 * @api public
 */

/**
 * 设置查询会使用的索引
 *
 * ####示例
 *
 *     query.hint({ indexA: 1, indexB: -1})
 *
 * ####注意
 *
 * 不能和 `distinct()` 一起使用
 *
 * @method hint
 * @memberOf Query
 * @param {Object} val a hint object
 * @return {Query} this
 * @see $hint http://docs.mongodb.org/manual/reference/operator/hint/
 * @api public
 */

/**
 * 指定包含或排除哪些字段（也叫做查询映射 "projection" ）
 *
 * 使用字符串语法时，有 `-` 前缀的路径会被排除，没有 `-` 前缀的路径会被选择。
 * 最后，如果路径有前缀 `+`，将被强制选择，这在路径被 [schema level](/docs/api.html#schematype_SchemaType-select) 排除的情况下会用到。
 *
 * 映射 _必须_ 是包含或排除二者其一。换句话说，只能要么列举包含的字段（将排除其他所有字段），要么列举排除的字段（将选择其他所有字段）。
 * [`_id` 字段总会被选择因为 MongoDB 默认会这么做](https://docs.mongodb.com/manual/tutorial/project-fields-from-query-results/#suppress-id-field).
 *
 * ####示例
 *
 *     // 选择 a 和 b 字段，排除其他的
 *     query.select('a b');
 *
 *     // 排除 c 和 d 字段，选择其他的
 *     query.select('-c -d');
 *
 *     // 如果已经存在"-"前缀的字段，可以用对象标记法
 *     query.select({ a: 1, b: 1 });
 *     query.select({ c: 0, d: 0 });
 *
 *     // 强制包含在 schema level 排除的字段
 *     query.select('+path')
 *
 * @method select
 * @memberOf Query
 * @param {Object|String} arg
 * @return {Query} this
 * @see SchemaType
 * @api public
 */

Query.prototype.select = function select() {
  var arg = arguments[0];
  if (!arg) return this;
  var i;
  var len;

  if (arguments.length !== 1) {
    throw new Error('Invalid select: select only takes 1 argument');
  }

  this._validate('select');

  var fields = this._fields || (this._fields = {});
  var userProvidedFields = this._userProvidedFields || (this._userProvidedFields = {});
  var type = typeof arg;

  if (('string' == type || Object.prototype.toString.call(arg) === '[object Arguments]') &&
    'number' == typeof arg.length || Array.isArray(arg)) {
    if ('string' == type)
      arg = arg.split(/\s+/);

    for (i = 0, len = arg.length; i < len; ++i) {
      var field = arg[i];
      if (!field) continue;
      var include = '-' == field[0] ? 0 : 1;
      if (include === 0) field = field.substring(1);
      fields[field] = include;
      userProvidedFields[field] = include;
    }

    return this;
  }

  if (utils.isObject(arg)) {
    var keys = Object.keys(arg);
    for (i = 0; i < keys.length; ++i) {
      fields[keys[i]] = arg[keys[i]];
      userProvidedFields[keys[i]] = arg[keys[i]];
    }
    return this;
  }

  throw new TypeError('Invalid select() argument. Must be string or object.');
};

/**
 * _已不赞成使用_ 设置 slaveOk 选项
 *
 * **Deprecated** 从 MongoDB 2.2 版本之后使用 [read preferences](#query_Query-read) 代替
 *
 * ####示例:
 *
 *     query.slaveOk() // true
 *     query.slaveOk(true)
 *     query.slaveOk(false)
 *
 * @method slaveOk
 * @memberOf Query
 * @deprecated use read() preferences instead if on mongodb >= 2.2
 * @param {Boolean} v defaults to true
 * @see mongodb http://docs.mongodb.org/manual/applications/replication/#read-preference
 * @see slaveOk http://docs.mongodb.org/manual/reference/method/rs.slaveOk/
 * @see read() #query_Query-read
 * @return {Query} this
 * @api public
 */

/**
 * 指定读数据的 MongoDB 节点
 *
 * ####首选项:
 *
 *     primary - (默认值)    只从主节点读取。如果主节点不可用则报错。不能一起使用 tags 选项。
 *     secondary            只有当从节点可用时从从节点读取，否则报错。
 *     primaryPreferred     优先读取主节点，不可用时读取从节点。
 *     secondaryPreferred   优先读取从节点，不可用时读取主节点。
 *     nearest              所有操作都读最近的可选节点，不同于其他模式，该选项会随机选取所有主、从节点。
 *
 * 选项别名：
 *
 *     p   primary
 *     pp  primaryPreferred
 *     s   secondary
 *     sp  secondaryPreferred
 *     n   nearest
 *
 * ####示例:
 *
 *     new Query().read('primary')
 *     new Query().read('p')  // 等效于 primary
 *
 *     new Query().read('primaryPreferred')
 *     new Query().read('pp') // 等效于 primaryPreferred
 *
 *     new Query().read('secondary')
 *     new Query().read('s')  // 等效于 secondary
 *
 *     new Query().read('secondaryPreferred')
 *     new Query().read('sp') // 等效于 secondaryPreferred
 *
 *     new Query().read('nearest')
 *     new Query().read('n')  // 等效于 nearest
 *
 *     // 读取匹配 tags 的从节点
 *     new Query().read('s', [{ dc:'sf', s: 1 },{ dc:'ma', s: 2 }])
 *
 * 从 [这里](http://docs.mongodb.org/manual/applications/replication/#read-preference) 和 [这里](http://mongodb.github.com/node-mongodb-native/driver-articles/anintroductionto1_1and2_2.html#read-preferences) 参阅更多 read 首选项的用法。
 *
 * @method read
 * @memberOf Query
 * @param {String} pref one of the listed preference options or aliases
 * @param {Array} [tags] optional tags for this query
 * @see mongodb http://docs.mongodb.org/manual/applications/replication/#read-preference
 * @see driver http://mongodb.github.com/node-mongodb-native/driver-articles/anintroductionto1_1and2_2.html#read-preferences
 * @return {Query} this
 * @api public
 */

Query.prototype.read = function read(pref, tags) {
  // first cast into a ReadPreference object to support tags
  var read = new ReadPreference(pref, tags);
  this.options.readPreference = read;
  return this;
};

/**
 * 设置查询选项。一些选项只对特定操作生效。
 *
 * ####选项：
 *
 * 以下选项只适用于 `find()`:
 * - [tailable](http://www.mongodb.org/display/DOCS/Tailable+Cursors)
 * - [sort](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%7B%7Bsort(\)%7D%7D)
 * - [limit](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%7B%7Blimit%28%29%7D%7D)
 * - [skip](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%7B%7Bskip%28%29%7D%7D)
 * - [maxscan](https://docs.mongodb.org/v3.2/reference/operator/meta/maxScan/#metaOp._S_maxScan)
 * - [batchSize](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%7B%7BbatchSize%28%29%7D%7D)
 * - [comment](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%24comment)
 * - [snapshot](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%7B%7Bsnapshot%28%29%7D%7D)
 * - [readPreference](http://docs.mongodb.org/manual/applications/replication/#read-preference)
 * - [hint](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%24hint)
 *
 * 以下选项只适用于 `update()`, `updateOne()`, `updateMany()`, `replaceOne()`, `findOneAndUpdate()`, 和 `findByIdAndUpdate()`:
 * - [upsert](https://docs.mongodb.com/manual/reference/method/db.collection.update/)
 * - [writeConcern](https://docs.mongodb.com/manual/reference/method/db.collection.update/)
 *
 * 以下选项只适用于 `find()`, `findOne()`, `findById()`, `findOneAndUpdate()`, 和 `findByIdAndUpdate()`:
 * - [lean](./api.html#query_Query-lean)
 *
 * 以下选项适用于所有操作 （**除这些以外** `update()`, `updateOne()`, `updateMany()`, `remove()`, `deleteOne()`, 和 `deleteMany()` ）:
 * - [maxTimeMS](https://docs.mongodb.com/manual/reference/operator/meta/maxTimeMS/)
 *
 * 以下选项适用于所有操作：
 * - [collation](https://docs.mongodb.com/manual/reference/collation/)
 *
 * @param {Object} options
 * @api public
 */

Query.prototype.setOptions = function(options, overwrite) {
  // overwrite is only for internal use
  if (overwrite) {
    // ensure that _mongooseOptions & options are two different objects
    this._mongooseOptions = (options && utils.clone(options)) || {};
    this.options = options || {};

    if ('populate' in options) {
      this.populate(this._mongooseOptions);
    }
    return this;
  }

  if (options == null) {
    return this;
  }

  if (Array.isArray(options.populate)) {
    var populate = options.populate;
    delete options.populate;
    var _numPopulate = populate.length;
    for (var i = 0; i < _numPopulate; ++i) {
      this.populate(populate[i]);
    }
  }

  if ('useFindAndModify' in options) {
    this._mongooseOptions.useFindAndModify = options.useFindAndModify;
    delete options.useFindAndModify;
  }
  if ('omitUndefined' in options) {
    this._mongooseOptions.omitUndefined = options.omitUndefined;
    delete options.omitUndefined;
  }

  return Query.base.setOptions.call(this, options);
};

/**
 * 以 JSON 对象格式返回当前的查询条件。
 *
 * ####示例:
 *
 *     var query = new Query();
 *     query.find({ a: 1 }).where('b').gt(2);
 *     query.getQuery(); // { a: 1, b: { $gt: 2 } }
 *
 * @return {Object} current query conditions
 * @api public
 */

Query.prototype.getQuery = function() {
  return this._conditions;
};

/**
 * 以 JSON 对象格式返回当前的更新项。
 *
 * ####示例:
 *
 *     var query = new Query();
 *     query.update({}, { $set: { a: 5 } });
 *     query.getUpdate(); // { $set: { a: 5 } }
 *
 * @return {Object} current update operations
 * @api public
 */

Query.prototype.getUpdate = function() {
  return this._update;
};

/**
 * Returns fields selection for this query.
 *
 * @method _fieldsForExec
 * @return {Object}
 * @api private
 * @receiver Query
 */

/**
 * Return an update document with corrected $set operations.
 *
 * @method _updateForExec
 * @api private
 * @receiver Query
 */

Query.prototype._updateForExec = function() {
  var update = utils.clone(this._update, {
    transform: false,
    depopulate: true
  });
  var ops = Object.keys(update);
  var i = ops.length;
  var ret = {};

  while (i--) {
    var op = ops[i];

    if (this.options.overwrite) {
      ret[op] = update[op];
      continue;
    }

    if ('$' !== op[0]) {
      // fix up $set sugar
      if (!ret.$set) {
        if (update.$set) {
          ret.$set = update.$set;
        } else {
          ret.$set = {};
        }
      }
      ret.$set[op] = update[op];
      ops.splice(i, 1);
      if (!~ops.indexOf('$set')) ops.push('$set');
    } else if ('$set' === op) {
      if (!ret.$set) {
        ret[op] = update[op];
      }
    } else {
      ret[op] = update[op];
    }
  }

  return ret;
};

/**
 * Makes sure _path is set.
 *
 * @method _ensurePath
 * @param {String} method
 * @api private
 * @receiver Query
 */

/**
 * Determines if `conds` can be merged using `mquery().merge()`
 *
 * @method canMerge
 * @memberOf Query
 * @param {Object} conds
 * @return {Boolean}
 * @api private
 */

/**
 * Returns default options for this query.
 *
 * @param {Model} model
 * @api private
 */

Query.prototype._optionsForExec = function(model) {
  const options = utils.clone(this.options);

  delete options.populate;
  model = model || this.model;

  if (!model) {
    return options;
  }

  if (!('safe' in options) && model.schema.options.safe) {
    options.safe = model.schema.options.safe;
  }

  if (!('readPreference' in options) && model.schema.options.read) {
    options.readPreference = model.schema.options.read;
  }

  if (options.upsert !== void 0) {
    options.upsert = !!options.upsert;
  }

  return options;
};

/**
 * 设置 lean 选项
 *
 * 激活 `lean` 选项的查询，返回的文档是普通 javascript 对象，而不是 [MongooseDocuments](#document-js)。
 * 这些对象没有 `save` 方法、getters/setters，也没有被赋予其他特殊功能 - Mongoose magic。
 *
 * ####示例:
 *
 *     new Query().lean() // true
 *     new Query().lean(true)
 *     new Query().lean(false)
 *
 *     Model.find().lean().exec(function (err, docs) {
 *       docs[0] instanceof mongoose.Document // false
 *     });
 *
 * 在高性能只读场景下这个选项就 [厉害](https://groups.google.com/forum/#!topic/mongoose-orm/u2_DzDydcnA/discussion) 了，特别是跟 [stream](#query_Query-stream) 一起用时。
 *
 * @param {Boolean|Object} bool 默认值 true
 * @return {Query} this
 * @api public
 */

Query.prototype.lean = function(v) {
  this._mongooseOptions.lean = arguments.length ? v : true;
  return this;
};

/**
 * 读/写 query 的错误（ error ）标识。如果标识不是 null 或
 * undefined， `exec()` promise 会直接执行 reject.
 *
 * ####示例:
 *
 *     Query().error(); // 读当前 error 值
 *     Query().error(null); // 置空当前 error
 *     Query().error(new Error('test')); // `exec()` will reject with test
 *     Schema.pre('find', function() {
 *       if (!this.getQuery().userId) {
 *         this.error(new Error('Not allowed to query without setting userId'));
 *       }
 *     });
 *
 * 注意：query casting 在 hooks **之后** 执行，所以 cast errors 会覆盖自定义 errors。
 *
 * ####示例:
 *     var TestSchema = new Schema({ num: Number });
 *     var TestModel = db.model('Test', TestSchema);
 *     TestModel.find({ num: 'not a number' }).error(new Error('woops')).exec(function(error) {
 *       // `error` will be a cast error because `num` failed to cast
 *     });
 *
 * @param {Error|null} err 如果设置了值，在把查询发送到 MongoDB 之前 `exec()` 就会报错
 * @returns {Query} this
 * @api public
 */

Query.prototype.error = function error(err) {
  if (arguments.length === 0) {
    return this._error;
  }

  this._error = err;
  return this;
};

/*!
 * ignore
 */

Query.prototype._unsetCastError = function _unsetCastError() {
  if (this._error != null && !(this._error instanceof CastError)) {
    return;
  }
  return this.error(null);
};

/**
 * Getter/setter around the current mongoose-specific options for this query
 * (populate, lean, etc.)
 *
 * @param {Object} options if specified, overwrites the current options
 * @returns {Object} the options
 * @api public
 */

Query.prototype.mongooseOptions = function(v) {
  if (arguments.length > 0) {
    this._mongooseOptions = v;
  }
  return this._mongooseOptions;
};

/*!
 * ignore
 */

Query.prototype._castConditions = function() {
  try {
    this.cast(this.model);
    this._unsetCastError();
  } catch (err) {
    this.error(err);
  }
};

/**
 * Thunk around find()
 *
 * @param {Function} [callback]
 * @return {Query} this
 * @api private
 */
Query.prototype._find = function(callback) {
  this._castConditions();

  if (this.error() != null) {
    callback(this.error());
    return this;
  }

  this._applyPaths();
  this._fields = this._castFields(this._fields);

  var fields = this._fieldsForExec();
  var mongooseOptions = this._mongooseOptions;
  var _this = this;
  var userProvidedFields = _this._userProvidedFields || {};

  var cb = function(err, docs) {
    if (err) {
      return callback(err);
    }

    if (docs.length === 0) {
      return callback(null, docs);
    }

    if (!mongooseOptions.populate) {
      return !!mongooseOptions.lean === true
        ? callback(null, docs)
        : completeMany(_this.model, docs, fields, userProvidedFields, null, callback);
    }

    var pop = helpers.preparePopulationOptionsMQ(_this, mongooseOptions);
    pop.__noPromise = true;
    _this.model.populate(docs, pop, function(err, docs) {
      if (err) return callback(err);
      return !!mongooseOptions.lean === true
        ? callback(null, docs)
        : completeMany(_this.model, docs, fields, userProvidedFields, pop, callback);
    });
  };

  var options = this._optionsForExec();
  options.fields = this._fieldsForExec();
  var filter = this._conditions;
  return this._collection.find(filter, options, cb);
};

/**
 * 查询文档
 *
 * 如果不传入 `callback` 查询不会被执行。查询被执行时，结果（ result ）是个文档数组。
 *
 * ####示例
 *
 *     query.find({ name: 'Los Pollos Hermanos' }).find(callback)
 *
 * @param {Object} [filter] mongodb selector
 * @param {Function} [callback]
 * @return {Query} this
 * @api public
 */

Query.prototype.find = function(conditions, callback) {
  if (typeof conditions === 'function') {
    callback = conditions;
    conditions = {};
  }

  conditions = utils.toObject(conditions);

  if (mquery.canMerge(conditions)) {
    this.merge(conditions);

    prepareDiscriminatorCriteria(this);
  } else if (conditions != null) {
    this.error(new ObjectParameterError(conditions, 'filter', 'find'));
  }

  // if we don't have a callback, then just return the query object
  if (!callback) {
    return Query.base.find.call(this);
  }

  this._find(callback);

  return this;
};

/**
 * 把另一个 Query 或者 条件对象（ condition ）合并到当前 query。
 *
 * 如果传入的是一个 Query 实例，条件对象、字段选择和选项都会被合并。
 *
 * 3.7.0版本新功能
 *
 * @method merge
 * @memberOf Query
 * @param {Query|Object} source
 * @return {Query} this
 */

Query.prototype.merge = function(source) {
  if (!source) {
    return this;
  }

  var opts = { overwrite: true };

  if (source instanceof Query) {
    // if source has a feature, apply it to ourselves

    if (source._conditions) {
      utils.merge(this._conditions, source._conditions, opts);
    }

    if (source._fields) {
      this._fields || (this._fields = {});
      utils.merge(this._fields, source._fields, opts);
    }

    if (source.options) {
      this.options || (this.options = {});
      utils.merge(this.options, source.options, opts);
    }

    if (source._update) {
      this._update || (this._update = {});
      utils.mergeClone(this._update, source._update);
    }

    if (source._distinct) {
      this._distinct = source._distinct;
    }

    return this;
  }

  // plain object
  utils.merge(this._conditions, source, opts);

  return this;
};

/*!
 * hydrates many documents
 *
 * @param {Model} model
 * @param {Array} docs
 * @param {Object} fields
 * @param {Query} self
 * @param {Array} [pop] array of paths used in population
 * @param {Function} callback
 */

function completeMany(model, docs, fields, userProvidedFields, pop, callback) {
  var arr = [];
  var count = docs.length;
  var len = count;
  var opts = pop ? { populated: pop } : undefined;
  var error = null;
  function init(_error) {
    if (_error != null) {
      error = error || _error;
    }
    if (error != null) {
      --count || process.nextTick(() => callback(error));
      return;
    }
    --count || process.nextTick(() => callback(error, arr));
  }
  for (var i = 0; i < len; ++i) {
    arr[i] = helpers.createModel(model, docs[i], fields, userProvidedFields);
    try {
      arr[i].init(docs[i], opts, init);
    } catch (error) {
      init(error);
    }
  }
}

/**
 * Adds a collation to this op (MongoDB 3.4 and up)
 *
 * @param {Object} value
 * @return {Query} this
 * @see MongoDB docs https://docs.mongodb.com/manual/reference/method/cursor.collation/#cursor.collation
 * @api public
 */

Query.prototype.collation = function(value) {
  if (this.options == null) {
    this.options = {};
  }
  this.options.collation = value;
  return this;
};

/**
 * Thunk around findOne()
 *
 * @param {Function} [callback]
 * @see findOne http://docs.mongodb.org/manual/reference/method/db.collection.findOne/
 * @api private
 */

Query.prototype._findOne = function(callback) {
  this._castConditions();

  if (this.error()) {
    return callback(this.error());
  }

  this._applyPaths();
  this._fields = this._castFields(this._fields);

  var options = this._mongooseOptions;
  var projection = this._fieldsForExec();
  var userProvidedFields = this._userProvidedFields || {};
  var _this = this;

  // don't pass in the conditions because we already merged them in
  Query.base.findOne.call(_this, {}, function(err, doc) {
    if (err) {
      return callback(err);
    }
    if (!doc) {
      return callback(null, null);
    }

    if (!options.populate) {
      return !!options.lean === true
        ? callback(null, doc)
        : completeOne(_this.model, doc, null, {}, projection, userProvidedFields, null, callback);
    }

    var pop = helpers.preparePopulationOptionsMQ(_this, options);
    pop.__noPromise = true;
    _this.model.populate(doc, pop, function(err, doc) {
      if (err) {
        return callback(err);
      }
      return !!options.lean === true
        ? callback(null, doc)
        : completeOne(_this.model, doc, null, {}, projection, userProvidedFields, pop, callback);
    });
  });
};

/**
 * 声明一个 findOne 查询。传给回调函数的结果是第一个查到的文档。
 *
 * 传入 `callback` 时启动查询。结果是单个文档。
 *
 * * *注意：* `conditions` 是可选的，如果 `conditions` 是 null 或 undefined，
 * mongoose 会向 MongoDB 发送一个空的 `findOne` 指令，返回结果会是一个随机文档。
 * 如果要按 `_id` 进行查询，可以用 `Model.findById()`。
 *
 * 这个函数触发以下中间件
 *
 * - `findOne()`
 *
 * ####示例
 *
 *     var query  = Kitten.where({ color: 'white' });
 *     query.findOne(function (err, kitten) {
 *       if (err) return handleError(err);
 *       if (kitten) {
 *         // 如果没有匹配的文档 kitten 是 null
 *       }
 *     });
 *
 * @param {Object} [conditions] mongodb selector
 * @param {Object} [projection] 可选 要返回的字段
 * @param {Object} [options] 见 [`setOptions()`](http://mongoosejs.com/docs/api.html#query_Query-setOptions)
 * @param {Function} [callback] 可选 回调参数是 (error, document)
 * @return {Query} this
 * @see findOne http://docs.mongodb.org/manual/reference/method/db.collection.findOne/
 * @see Query.select #query_Query-select
 * @api public
 */

Query.prototype.findOne = function(conditions, projection, options, callback) {
  if (typeof conditions === 'function') {
    callback = conditions;
    conditions = null;
    projection = null;
    options = null;
  } else if (typeof projection === 'function') {
    callback = projection;
    options = null;
    projection = null;
  } else if (typeof options === 'function') {
    callback = options;
    options = null;
  }

  // make sure we don't send in the whole Document to merge()
  conditions = utils.toObject(conditions);

  this.op = 'findOne';

  if (options) {
    this.setOptions(options);
  }

  if (projection) {
    this.select(projection);
  }

  if (mquery.canMerge(conditions)) {
    this.merge(conditions);

    prepareDiscriminatorCriteria(this);
  } else if (conditions != null) {
    this.error(new ObjectParameterError(conditions, 'filter', 'findOne'));
  }

  if (!callback) {
    // already merged in the conditions, don't need to send them in.
    return Query.base.findOne.call(this);
  }

  this._findOne(callback);

  return this;
};

/**
 * Thunk around count()
 *
 * @param {Function} [callback]
 * @see count http://docs.mongodb.org/manual/reference/method/db.collection.count/
 * @api private
 */

Query.prototype._count = function(callback) {
  try {
    this.cast(this.model);
  } catch (err) {
    this.error(err);
  }

  if (this.error()) {
    return callback(this.error());
  }

  var conds = this._conditions;
  var options = this._optionsForExec();

  this._collection.count(conds, options, utils.tick(callback));
};

/**
 * 声明一个 `count` 查询
 *
 * 传入 `callback` 时启动查询
 *
 * 这个函数触发以下中间件
 *
 * - `count()`
 *
 * ####示例:
 *
 *     var countQuery = model.where({ 'color': 'black' }).count();
 *
 *     query.count({ color: 'black' }).count(callback)
 *
 *     query.count({ color: 'black' }, callback)
 *
 *     query.where('color', 'black').count(function (err, count) {
 *       if (err) return handleError(err);
 *       console.log('there are %d kittens', count);
 *     })
 *
 * @param {Object} [conditions] mongodb selector
 * @param {Function} [callback] 可选 回调参数是 (error, count)
 * @return {Query} this
 * @see count http://docs.mongodb.org/manual/reference/method/db.collection.count/
 * @api public
 */

Query.prototype.count = function(conditions, callback) {
  if (typeof conditions === 'function') {
    callback = conditions;
    conditions = undefined;
  }

  conditions = utils.toObject(conditions);

  if (mquery.canMerge(conditions)) {
    this.merge(conditions);
  }

  this.op = 'count';
  if (!callback) {
    return this;
  }

  this._count(callback);

  return this;
};

/**
 * 声明或执行 distict() 操作
 *
 * 传入 `callback` 启动查询
 *
 * 这个函数不触发中间件
 *
 * ####示例
 *
 *     distinct(field, conditions, callback)
 *     distinct(field, conditions)
 *     distinct(field, callback)
 *     distinct(field)
 *     distinct(callback)
 *     distinct()
 *
 * @param {String} [field]
 * @param {Object|Query} [filter]
 * @param {Function} [callback] 可选 回调参数是 (error, arr)
 * @return {Query} this
 * @see distinct http://docs.mongodb.org/manual/reference/method/db.collection.distinct/
 * @api public
 */

Query.prototype.distinct = function(field, conditions, callback) {
  if (!callback) {
    if (typeof conditions === 'function') {
      callback = conditions;
      conditions = undefined;
    } else if (typeof field === 'function') {
      callback = field;
      field = undefined;
      conditions = undefined;
    }
  }

  conditions = utils.toObject(conditions);

  if (mquery.canMerge(conditions)) {
    this.merge(conditions);

    prepareDiscriminatorCriteria(this);
  } else if (conditions != null) {
    this.error(new ObjectParameterError(conditions, 'filter', 'distinct'));
  }

  if (callback != null) {
    this._castConditions();

    if (this.error() != null) {
      callback(this.error());
      return this;
    }
  }

  return Query.base.distinct.call(this, {}, field, callback);
};

/**
 * 设置排序
 *
 * 如果传入的参数是个对象，属性值可以是 `asc`, `desc`, `ascending`, `descending`, `1`, 和 `-1`。
 *
 * 如果传入参数是字符串，它得是以空格间隔的字段路径名列表。每个字段的排列顺序默认是正序，如果字段名有 `-` 前缀，
 * 那么这个字段是倒序。
 *
 * ####示例
 *
 *     // 按照 "field" 字段正序、"test" 字段倒序排列
 *     query.sort({ field: 'asc', test: -1 });
 *
 *     // 等效于
 *     query.sort('field -test');
 *
 * ####注意
 *
 * 不能和 `distinct()` 一起使用
 *
 * @param {Object|String} arg
 * @return {Query} this
 * @see cursor.sort http://docs.mongodb.org/manual/reference/method/cursor.sort/
 * @api public
 */

Query.prototype.sort = function(arg) {
  if (arguments.length > 1) {
    throw new Error('sort() only takes 1 Argument');
  }

  return Query.base.sort.call(this, arg);
};

/**
 * 声明 / 执行删除操作
 *
 * 这个函数不触发中间件
 *
 * ####示例
 *
 *     Model.remove({ artist: 'Anne Murray' }, callback)
 *
 * ####注意
 *
 * 只有当传入 callback 时操作才会被执行。如果要强制不带 callback 就执行，你得先调用 `remove()` 然后调用 `exec()` 来让它执行。
 *
 *     // 不会执行
 *     var query = Model.find().remove({ name: 'Anne Murray' })
 *
 *     // 会被执行
 *     query.remove({ name: 'Anne Murray' }, callback)
 *     query.remove({ name: 'Anne Murray' }).remove(callback)
 *
 *     // 没有 callback 就执行
 *     query.exec()
 *
 *     // 总结
 *     query.remove(conds, fn); // 执行
 *     query.remove(conds)
 *     query.remove(fn) // 执行
 *     query.remove()
 *
 * @param {Object|Query} [filter] mongodb selector
 * @param {Function} [callback] 可选 回调参数是 (error, writeOpResult)
 * @return {Query} this
 * @see writeOpResult http://mongodb.github.io/node-mongodb-native/2.2/api/Collection.html#~WriteOpResult
 * @see remove http://docs.mongodb.org/manual/reference/method/db.collection.remove/
 * @api public
 */

Query.prototype.remove = function(filter, callback) {
  if (typeof filter === 'function') {
    callback = filter;
    filter = null;
  }

  filter = utils.toObject(filter);

  if (mquery.canMerge(filter)) {
    this.merge(filter);

    prepareDiscriminatorCriteria(this);
  } else if (filter != null) {
    this.error(new ObjectParameterError(filter, 'filter', 'remove'));
  }

  if (!callback) {
    return Query.base.remove.call(this);
  }

  this._remove(callback);
  return this;
};

/*!
 * ignore
 */

Query.prototype._remove = function(callback) {
  this._castConditions();

  if (this.error() != null) {
    callback(this.error());
    return this;
  }

  return Query.base.remove.call(this, helpers.handleWriteOpResult(callback));
};

/**
 * 声明 / 执行 `deleteOne()` 操作。
 * 功能类似 remove，不过会忽略 `single` 选项最多删除一条文档。
 *
 * 这个函数不触发中间件.
 *
 * ####示例
 *
 *     Character.deleteOne({ name: 'Eddard Stark' }, callback)
 *     Character.deleteOne({ name: 'Eddard Stark' }).then(next)
 *
 * @param {Object|Query} [filter] mongodb selector
 * @param {Function} [callback] 可选 回调参数是 (error, writeOpResult)
 * @return {Query} this
 * @see writeOpResult http://mongodb.github.io/node-mongodb-native/2.2/api/Collection.html#~WriteOpResult
 * @see remove http://docs.mongodb.org/manual/reference/method/db.collection.remove/
 * @api public
 */

Query.prototype.deleteOne = function(filter, callback) {
  if (typeof filter === 'function') {
    callback = filter;
    filter = null;
  }

  filter = utils.toObject(filter);

  if (mquery.canMerge(filter)) {
    this.merge(filter);

    prepareDiscriminatorCriteria(this);
  } else if (filter != null) {
    this.error(new ObjectParameterError(filter, 'filter', 'deleteOne'));
  }

  if (!callback) {
    return Query.base.deleteOne.call(this);
  }

  this._deleteOne.call(this, callback);

  return this;
};

/*!
 * ignore
 */

Query.prototype._deleteOne = function(callback) {
  this._castConditions();

  if (this.error() != null) {
    callback(this.error());
    return this;
  }

  return Query.base.deleteOne.call(this, helpers.handleWriteOpResult(callback));
};

/**
 * 声明 / 执行一次 `deleteMany()` 操作。功能类似于 remove，不过会忽略 `single` 选项，删除集合中 _每一条_ 匹配条件的文档。
 *
 * 这个函数不触发中间件
 *
 * ####示例
 *
 *     Character.deleteMany({ name: /Stark/, age: { $gte: 18 } }, callback)
 *     Character.deleteMany({ name: /Stark/, age: { $gte: 18 } }).then(next)
 *
 * @param {Object|Query} [filter] mongodb selector
 * @param {Function} [callback] 可选 回调参数是 (error, writeOpResult)
 * @return {Query} this
 * @see writeOpResult http://mongodb.github.io/node-mongodb-native/2.2/api/Collection.html#~WriteOpResult
 * @see remove http://docs.mongodb.org/manual/reference/method/db.collection.remove/
 * @api public
 */

Query.prototype.deleteMany = function(filter, callback) {
  if (typeof filter === 'function') {
    callback = filter;
    filter = null;
  }

  filter = utils.toObject(filter);

  if (mquery.canMerge(filter)) {
    this.merge(filter);

    prepareDiscriminatorCriteria(this);
  } else if (filter != null) {
    this.error(new ObjectParameterError(filter, 'filter', 'deleteMany'));
  }

  if (!callback) {
    return Query.base.deleteMany.call(this);
  }

  this._deleteMany.call(this, callback);

  return this;
};

/*!
 * ignore
 */

Query.prototype._deleteMany = function(callback) {
  this._castConditions();

  if (this.error() != null) {
    callback(this.error());
    return this;
  }

  return Query.base.deleteMany.call(this, helpers.handleWriteOpResult(callback));
};

/*!
 * hydrates a document
 *
 * @param {Model} model
 * @param {Document} doc
 * @param {Object} res 3rd parameter to callback
 * @param {Object} fields
 * @param {Query} self
 * @param {Array} [pop] array of paths used in population
 * @param {Function} callback
 */

function completeOne(model, doc, res, options, fields, userProvidedFields, pop, callback) {
  var opts = pop ?
    {populated: pop}
    : undefined;

  var casted = helpers.createModel(model, doc, fields, userProvidedFields);
  try {
    casted.init(doc, opts, _init);
  } catch (error) {
    _init(error);
  }

  function _init(err) {
    if (err) {
      return process.nextTick(() => callback(err));
    }

    if (options.rawResult) {
      res.value = casted;
      return process.nextTick(() => callback(null, res));
    }
    process.nextTick(() => callback(null, casted));
  }
}

/*!
 * If the model is a discriminator type and not root, then add the key & value to the criteria.
 */

function prepareDiscriminatorCriteria(query) {
  if (!query || !query.model || !query.model.schema) {
    return;
  }

  var schema = query.model.schema;

  if (schema && schema.discriminatorMapping && !schema.discriminatorMapping.isRoot) {
    query._conditions[schema.discriminatorMapping.key] = schema.discriminatorMapping.value;
  }
}

/**
 * 向 mongodb 发起一条 [findAndModify](http://www.mongodb.org/display/DOCS/findAndModify+Command) 更新指令。
 *
 * 查到一条匹配的文档，依据 `doc` 参数和 `options` 选项更新文档，向回调函数返回查询到的文档（如果有的话）。如果传入了 `callback` 则查询会立即执行。
 *
 * 这个函数触发以下中间件
 *
 * - `findOneAndUpdate()`
 *
 * ####支持的选项
 *
 * - `new`: bool - 如果设置为 true ，不再返回旧文档而是更新后的文档。默认值 false （从 4.0 版本开始）
 * - `upsert`: bool - 如果文档不存在则插入一条新数据。默认值 false
 * - `fields`: {Object|String} - 选择字段。等效于 `.select(fields).findOneAndUpdate()`
 * - `sort`: 如果查询条件匹配多条文档，可以设置排序条件以确定更新哪条文档（排序后的第一条）
 * - `maxTimeMS`: puts a time limit on the query - requires mongodb >= 2.6.0
 * - `runValidators`: 如果值为 true，更新操作执行时会做 [update validators](/docs/validation.html#update-validators) 。 Update validators 会依照 model 的 schema 对更新操作做校验。
 * - `setDefaultsOnInsert`: 如果该选项和 `upsert` 都是 true， mongoose 会在插入新文档时应用 schema 中指定的 [默认值](http://mongoosejs.com/docs/defaults.html)。该选项只会在 MongoDB 2.4 版本及以上生效，因为它依赖 MongoDB 的 [`$setOnInsert`](https://docs.mongodb.org/v2.4/reference/operator/update/setOnInsert/) 操作符。
 * - `rawResult`: 如果值为 true，将返回 MongoDB 驱动的 [原生结果（raw result）](http://mongodb.github.io/node-mongodb-native/2.0/api/Collection.html#findAndModify)
 * - `context`: string - if set to 'query' and `runValidators` is on, `this` will refer to the query in custom validator functions that update validation runs. Does nothing if `runValidators` is false.
 *
 * ####回调函数签名
 *     function(error, doc) {
 *       // error: 发生错误时有值
 *       // doc: 如果 `new: false` 则为更新前的文档；如果 `new: true` 则为更新后的文档
 *     }
 *
 * ####示例
 *
 *     query.findOneAndUpdate(conditions, update, options, callback) // executes
 *     query.findOneAndUpdate(conditions, update, options)  // returns Query
 *     query.findOneAndUpdate(conditions, update, callback) // executes
 *     query.findOneAndUpdate(conditions, update)           // returns Query
 *     query.findOneAndUpdate(update, callback)             // returns Query
 *     query.findOneAndUpdate(update)                       // returns Query
 *     query.findOneAndUpdate(callback)                     // executes
 *     query.findOneAndUpdate()                             // returns Query
 *
 * @method findOneAndUpdate
 * @memberOf Query
 * @param {Object|Query} [query]
 * @param {Object} [doc]
 * @param {Object} [options]
 * @param {Boolean} [options.rawResult]
 * @param {Boolean|String} [options.strict] 覆盖 schema 的 [严格模式](http://mongoosejs.com/docs/guide.html#strict)选项
 * @param {Boolean} [options.multipleCastError] 默认情况下 mongoose 只返回第一个 cast 错误。 Turn on this option to aggregate all the cast errors.
 * @param {Object} [options.lean] 如果值是 true， mongoose 以 plain JavaScript object 格式返回文档，不再实例化成一个 model 文档。参阅 [`Query.lean()`](http://mongoosejs.com/docs/api.html#query_Query-lean).
 * @param {Function} [callback] 可选 回调参数是 (error, doc), _除非_ 设置了 `rawResult` 选项，那么参数将是 (error, writeOpResult)
 * @see mongodb http://www.mongodb.org/display/DOCS/findAndModify+Command
 * @see writeOpResult http://mongodb.github.io/node-mongodb-native/2.2/api/Collection.html#~WriteOpResult
 * @return {Query} this
 * @api public
 */

Query.prototype.findOneAndUpdate = function(criteria, doc, options, callback) {
  this.op = 'findOneAndUpdate';
  this._validate();

  switch (arguments.length) {
    case 3:
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      break;
    case 2:
      if (typeof doc === 'function') {
        callback = doc;
        doc = criteria;
        criteria = undefined;
      }
      options = undefined;
      break;
    case 1:
      if (typeof criteria === 'function') {
        callback = criteria;
        criteria = options = doc = undefined;
      } else {
        doc = criteria;
        criteria = options = undefined;
      }
  }

  if (mquery.canMerge(criteria)) {
    this.merge(criteria);
  }

  // apply doc
  if (doc) {
    this._mergeUpdate(doc);
  }

  if (options) {
    options = utils.clone(options);
    if (options.projection) {
      this.select(options.projection);
      delete options.projection;
    }
    if (options.fields) {
      this.select(options.fields);
      delete options.fields;
    }

    this.setOptions(options);
  }

  if (!callback) {
    return this;
  }

  this._findOneAndUpdate(callback);

  return this;
};

/*!
 * Thunk around findOneAndUpdate()
 *
 * @param {Function} [callback]
 * @api private
 */

Query.prototype._findOneAndUpdate = function(callback) {
  if (this.error() != null) {
    return callback(this.error());
  }

  this._findAndModify('update', callback);
  return this;
};

/**
 * 发起一条 mongodb [findAndModify](http://www.mongodb.org/display/DOCS/findAndModify+Command) 删除指令。
 *
 * 查询一条匹配的文档，把它删掉，并回传给回调函数。如果有 `callback` 参数，删除指令会立即执行。
 *
 * 这个函数触发以下中间件
 *
 * - `findOneAndRemove()`
 *
 * ####可选项
 *
 * - `sort`: 设置排序，如果多条文档匹配查询条件，将影响到实际更新哪条文档（只会更新第一条）
 * - `maxTimeMS`: 对查询设置时间限制 - 需要 mongodb 2.6.0 及以上版本
 * - `rawResult`: 如果设置为 true，返回结果将是 [MongoDB 驱动的原生结果](http://mongodb.github.io/node-mongodb-native/2.0/api/Collection.html#findAndModify)
 *
 * ####回调函数签名
 *     function(error, doc) {
 *       // error: 可能爆出的错误
 *       // doc: 若 `new = false` 则是更新之前的文档，若 `new = true` 则是更新之后的文档
 *     }
 *
 * ####示例
 *
 *     A.where().findOneAndRemove(conditions, options, callback) // executes
 *     A.where().findOneAndRemove(conditions, options)  // return Query
 *     A.where().findOneAndRemove(conditions, callback) // executes
 *     A.where().findOneAndRemove(conditions) // returns Query
 *     A.where().findOneAndRemove(callback)   // executes
 *     A.where().findOneAndRemove()           // returns Query
 *
 * @method findOneAndRemove
 * @memberOf Query
 * @param {Object} [conditions]
 * @param {Object} [options]
 * @param {Boolean} [options.rawResult] 如果值为 true，则返回 [MongoDB 驱动的原生结果](http://mongodb.github.io/node-mongodb-native/2.0/api/Collection.html#findAndModify)
 * @param {Boolean|String} [options.strict] 覆盖 schema 的 [strict mode 选项](http://mongoosejs.com/docs/guide.html#strict)
 * @param {Function} [callback] 可选 回调参数是 (error, document)
 * @return {Query} this
 * @see mongodb http://www.mongodb.org/display/DOCS/findAndModify+Command
 * @api public
 */

Query.prototype.findOneAndRemove = function(conditions, options, callback) {
  this.op = 'findOneAndRemove';
  this._validate();

  switch (arguments.length) {
    case 2:
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      break;
    case 1:
      if (typeof conditions === 'function') {
        callback = conditions;
        conditions = undefined;
        options = undefined;
      }
      break;
  }

  if (mquery.canMerge(conditions)) {
    this.merge(conditions);
  }

  options && this.setOptions(options);

  if (!callback) {
    return this;
  }

  this._findOneAndRemove(callback);

  return this;
};

/*!
 * Thunk around findOneAndRemove()
 *
 * @param {Function} [callback]
 * @return {Query} this
 * @api private
 */
Query.prototype._findOneAndRemove = function(callback) {
  if (this.error() != null) {
    return callback(this.error());
  }

  Query.base.findOneAndRemove.call(this, callback);
};

/*!
 * Override mquery.prototype._findAndModify to provide casting etc.
 *
 * @param {String} type - either "remove" or "update"
 * @param {Function} callback
 * @api private
 */

Query.prototype._findAndModify = function(type, callback) {
  if (typeof callback !== 'function') {
    throw new Error('Expected callback in _findAndModify');
  }

  var model = this.model;
  var schema = model.schema;
  var _this = this;
  var castedQuery;
  var castedDoc = this._update;
  var fields;
  var opts;
  var doValidate;

  castedQuery = castQuery(this);
  if (castedQuery instanceof Error) {
    return callback(castedQuery);
  }

  opts = this._optionsForExec(model);

  if ('strict' in opts) {
    this._mongooseOptions.strict = opts.strict;
  }

  var isOverwriting = this.options.overwrite && !hasDollarKeys(castedDoc);
  if (isOverwriting) {
    castedDoc = new this.model(castedDoc, null, true);
  }

  if (type === 'remove') {
    opts.remove = true;
  } else {
    if (!('new' in opts)) {
      opts.new = false;
    }
    if (!('upsert' in opts)) {
      opts.upsert = false;
    }
    if (opts.upsert || opts['new']) {
      opts.remove = false;
    }

    if (isOverwriting) {
      doValidate = function(callback) {
        castedDoc.validate(callback);
      };
    } else {
      castedDoc = castDoc(this, opts.overwrite);
      castedDoc = setDefaultsOnInsert(this._conditions, schema, castedDoc, opts);
      if (!castedDoc) {
        if (opts.upsert) {
          // still need to do the upsert to empty doc
          var doc = utils.clone(castedQuery);
          delete doc._id;
          castedDoc = {$set: doc};
        } else {
          this.findOne(callback);
          return this;
        }
      } else if (castedDoc instanceof Error) {
        return callback(castedDoc);
      } else {
        // In order to make MongoDB 2.6 happy (see
        // https://jira.mongodb.org/browse/SERVER-12266 and related issues)
        // if we have an actual update document but $set is empty, junk the $set.
        if (castedDoc.$set && Object.keys(castedDoc.$set).length === 0) {
          delete castedDoc.$set;
        }
      }

      doValidate = updateValidators(this, schema, castedDoc, opts);
    }
  }

  this._applyPaths();
  var userProvidedFields = this._userProvidedFields || {};

  var options = this._mongooseOptions;

  if (this._fields) {
    fields = utils.clone(this._fields);
    opts.fields = this._castFields(fields);
    if (opts.fields instanceof Error) {
      return callback(opts.fields);
    }
  }

  if (opts.sort) convertSortToArray(opts);

  var cb = function(err, doc, res) {
    if (err) {
      return callback(err);
    }

    if (!doc || (utils.isObject(doc) && Object.keys(doc).length === 0)) {
      if (opts.rawResult) {
        return callback(null, res);
      }
      return callback(null, null);
    }

    if (!options.populate) {
      if (!!options.lean === true) {
        return _completeOneLean(doc, res, opts, callback);
      }
      return completeOne(_this.model, doc, res, opts, fields, userProvidedFields, null, callback);
    }

    var pop = helpers.preparePopulationOptionsMQ(_this, options);
    pop.__noPromise = true;
    _this.model.populate(doc, pop, function(err, doc) {
      if (err) {
        return callback(err);
      }

      if (!!options.lean === true) {
        return _completeOneLean(doc, res, opts, callback);
      }
      return completeOne(_this.model, doc, res, opts, fields, userProvidedFields, pop, callback);
    });
  };

  var _callback;

  var useFindAndModify = true;
  var base = _this.model && _this.model.base;
  if ('useFindAndModify' in base.options) {
    useFindAndModify = base.get('useFindAndModify');
  }
  if ('useFindAndModify' in options) {
    useFindAndModify = options.useFindAndModify;
  }
  if (useFindAndModify === false) {
    // Bypass mquery
    var collection = _this._collection.collection;
    if ('new' in opts) {
      opts.returnOriginal = !opts['new'];
      delete opts['new'];
    }
    if ('fields' in opts) {
      opts.projection = opts.fields;
      delete opts.fields;
    }

    if (type === 'remove') {
      collection.findOneAndDelete(castedQuery, opts, utils.tick(function(error, res) {
        return cb(error, res ? res.value : res, res);
      }));

      return this;
    }

    if (opts.runValidators && doValidate) {
      _callback = function(error) {
        if (error) {
          return callback(error);
        }
        if (castedDoc && castedDoc.toBSON) {
          castedDoc = castedDoc.toBSON();
        }
        collection.findOneAndUpdate(castedQuery, castedDoc, opts, utils.tick(function(error, res) {
          return cb(error, res ? res.value : res, res);
        }));
      };

      try {
        doValidate(_callback);
      } catch (error) {
        callback(error);
      }
    } else {
      if (castedDoc && castedDoc.toBSON) {
        castedDoc = castedDoc.toBSON();
      }
      collection.findOneAndUpdate(castedQuery, castedDoc, opts, utils.tick(function(error, res) {
        return cb(error, res ? res.value : res, res);
      }));
    }

    return this;
  }

  if (opts.runValidators && doValidate) {
    _callback = function(error) {
      if (error) {
        return callback(error);
      }
      if (castedDoc && castedDoc.toBSON) {
        castedDoc = castedDoc.toBSON();
      }
      _this._collection.findAndModify(castedQuery, castedDoc, opts, utils.tick(function(error, res) {
        return cb(error, res ? res.value : res, res);
      }));
    };

    try {
      doValidate(_callback);
    } catch (error) {
      callback(error);
    }
  } else {
    if (castedDoc && castedDoc.toBSON) {
      castedDoc = castedDoc.toBSON();
    }
    this._collection.findAndModify(castedQuery, castedDoc, opts, utils.tick(function(error, res) {
      return cb(error, res ? res.value : res, res);
    }));
  }

  return this;
};

/*!
 * ignore
 */

function _completeOneLean(doc, res, opts, callback) {
  if (opts.rawResult) {
    return callback(null, res);
  }
  return callback(null, doc);
}

/*!
 * Override mquery.prototype._mergeUpdate to handle mongoose objects in
 * updates.
 *
 * @param {Object} doc
 * @api private
 */

Query.prototype._mergeUpdate = function(doc) {
  if (!this._update) this._update = {};
  if (doc instanceof Query) {
    if (doc._update) {
      utils.mergeClone(this._update, doc._update);
    }
  } else {
    utils.mergeClone(this._update, doc);
  }
};

/*!
 * The mongodb driver 1.3.23 only supports the nested array sort
 * syntax. We must convert it or sorting findAndModify will not work.
 */

function convertSortToArray(opts) {
  if (Array.isArray(opts.sort)) {
    return;
  }
  if (!utils.isObject(opts.sort)) {
    return;
  }

  var sort = [];

  for (var key in opts.sort) {
    if (utils.object.hasOwnProperty(opts.sort, key)) {
      sort.push([key, opts.sort[key]]);
    }
  }

  opts.sort = sort;
}

/*!
 * ignore
 */

function _updateThunk(op, callback) {
  var schema = this.model.schema;
  var doValidate;
  var _this = this;

  this._castConditions();

  if (this.error() != null) {
    callback(this.error());
    return this;
  }

  var castedQuery = this._conditions;
  var castedDoc;
  var options = this._optionsForExec(this.model);

  this._update = utils.clone(this._update, options);
  var isOverwriting = this.options.overwrite && !hasDollarKeys(this._update);
  if (isOverwriting) {
    castedDoc = new this.model(this._update, null, true);
  } else {
    castedDoc = castDoc(this, options.overwrite);

    if (castedDoc instanceof Error) {
      callback(castedDoc);
      return this;
    }

    if (castedDoc == null || Object.keys(castedDoc).length === 0) {
      callback(null, 0);
      return this;
    }

    castedDoc = setDefaultsOnInsert(this._conditions, this.model.schema,
      castedDoc, options);
  }

  if (this.options.runValidators) {
    if (isOverwriting) {
      doValidate = function(callback) {
        castedDoc.validate(callback);
      };
    } else {
      doValidate = updateValidators(this, schema, castedDoc, options);
    }
    var _callback = function(err) {
      if (err) {
        return callback(err);
      }

      if (castedDoc.toBSON) {
        castedDoc = castedDoc.toBSON();
      }
      _this._collection[op](castedQuery, castedDoc, options, callback);
    };
    try {
      doValidate(_callback);
    } catch (err) {
      process.nextTick(function() {
        callback(err);
      });
    }
    return this;
  }

  if (castedDoc.toBSON) {
    castedDoc = castedDoc.toBSON();
  }

  this._collection[op](castedQuery, castedDoc, options, callback);
  return this;
}

/*!
 * Internal thunk for .update()
 *
 * @param {Function} callback
 * @see Model.update #model_Model.update
 * @api private
 */
Query.prototype._execUpdate = function(callback) {
  return _updateThunk.call(this, 'update', callback);
};

/*!
 * Internal thunk for .updateMany()
 *
 * @param {Function} callback
 * @see Model.update #model_Model.update
 * @api private
 */
Query.prototype._updateMany = function(callback) {
  return _updateThunk.call(this, 'updateMany', callback);
};

/*!
 * Internal thunk for .updateOne()
 *
 * @param {Function} callback
 * @see Model.update #model_Model.update
 * @api private
 */
Query.prototype._updateOne = function(callback) {
  return _updateThunk.call(this, 'updateOne', callback);
};

/*!
 * Internal thunk for .replaceOne()
 *
 * @param {Function} callback
 * @see Model.replaceOne #model_Model.replaceOne
 * @api private
 */
Query.prototype._replaceOne = function(callback) {
  return _updateThunk.call(this, 'replaceOne', callback);
};

/**
 * 声明且（/或）执行当前查询为 update() 操作。
 *
 * _被传入的路径中非原子（$atomic）的操作，会以 $set 进行执行。_
 *
 * 这个函数触发以下中间件
 *
 * - `update()`
 *
 * ####示例
 *
 *     Model.where({ _id: id }).update({ title: 'words' })
 *
 *     // becomes
 *
 *     Model.where({ _id: id }).update({ $set: { title: 'words' }})
 *
 * ####可用选项:
 *
 *  - `safe` (boolean) 安全模式（默认值同 schema 中的定义（true））
 *  - `upsert` (boolean) 没有匹配文档时是否创建新文档 (false)
 *  - `multi` (boolean) 是否更新多条文档 (false)
 *  - `runValidators`: 如果设为 true，这条命令将执行 [update validators](/docs/validation.html#update-validators) 。 Update validators 依据 schema 校验更新选项。
 *  - `setDefaultsOnInsert`: 如果该选项跟 `upsert` 都为 true，创建新文档时 mongoose 会应用 schema 中指定的 [默认值](http://mongoosejs.com/docs/defaults.html) 。 该选项只能用于 MongoDB >= 2.4 ，因为依赖于 [MongoDB's `$setOnInsert` ](https://docs.mongodb.org/v2.4/reference/operator/update/setOnInsert/)操作符。
 *  - `strict` (boolean) 覆盖当前 update 的 `strict` 选项
 *  - `overwrite` (boolean) 禁用 update-only 模式，允许你替换整个文档 (false)
 *  - `context` (string) if set to 'query' and `runValidators` is on, `this` will refer to the query in custom validator functions that update validation runs. 如果 `runValidators` 是 false 则什么都不做。
 *
 * ####注意
 *
 * doc 参数被传入空对象 `{}` 会造成一次空操作，除非 `overwrite` 选项被激活。`overwrite` 选项没有激活的情况下，update 命令不会发送给 MongoDB 而被忽略，回调函数直接被调用，以防止数据集合的文档被意外覆盖。
 *
 * ####注意
 *
 * 只有传入了回调函数，操作才会被执行。要想强制执行回调，你得先调用 update() 然后用 `exec()` 方法使其执行。
 *
 *     var q = Model.where({ _id: id });
 *     q.update({ $set: { name: 'bob' }}).update(); // not executed
 *
 *     q.update({ $set: { name: 'bob' }}).exec(); // executed
 *
 *     // 非 $atomic ops 的键都会被转换成 $set。
 *     // 本句执行跟上例一样的命令。
 *     q.update({ name: 'bob' }).exec();
 *
 *     // 用空文档替换更新
 *     var q = Model.where({ _id: id }).setOptions({ overwrite: true })
 *     q.update({ }, callback); // executes
 *
 *     // 用空文档进行多条替换更新
 *     var q = Model.where({ _id: id });
 *     q.setOptions({ multi: true, overwrite: true })
 *     q.update({ });
 *     q.update(callback); // executed
 *
 *     // 多条更新
 *     Model.where()
 *          .update({ name: /^match/ }, { $set: { arr: [] }}, { multi: true }, callback)
 *
 *     // 再多一例多条更新
 *     Model.where()
 *          .setOptions({ multi: true })
 *          .update({ $set: { arr: [] }}, callback)
 *
 *     // 默认是单条更新
 *     Model.where({ email: 'address@example.com' })
 *          .update({ $inc: { counter: 1 }}, callback)
 *
 * API summary
 *
 *     update(criteria, doc, options, cb) // executes
 *     update(criteria, doc, options)
 *     update(criteria, doc, cb) // executes
 *     update(criteria, doc)
 *     update(doc, cb) // executes
 *     update(doc)
 *     update(cb) // executes
 *     update(true) // executes
 *     update()
 *
 * @param {Object} [criteria]
 * @param {Object} [doc] the update command
 * @param {Object} [options]
 * @param {Boolean} [options.multipleCastError] 默认情况下，mongoose 只返回 query 转换中报的第一个错。激活该选项会聚合转换中所有的报错。
 * @param {Function} [callback] 可选，形参是 (error, writeOpResult)
 * @return {Query} this
 * @see Model.update #model_Model.update
 * @see update http://docs.mongodb.org/manual/reference/method/db.collection.update/
 * @see writeOpResult http://mongodb.github.io/node-mongodb-native/2.2/api/Collection.html#~WriteOpResult
 * @api public
 */

Query.prototype.update = function(conditions, doc, options, callback) {
  if (typeof options === 'function') {
    // .update(conditions, doc, callback)
    callback = options;
    options = null;
  } else if (typeof doc === 'function') {
    // .update(doc, callback);
    callback = doc;
    doc = conditions;
    conditions = {};
    options = null;
  } else if (typeof conditions === 'function') {
    // .update(callback)
    callback = conditions;
    conditions = undefined;
    doc = undefined;
    options = undefined;
  } else if (typeof conditions === 'object' && !doc && !options && !callback) {
    // .update(doc)
    doc = conditions;
    conditions = undefined;
    options = undefined;
    callback = undefined;
  }

  return _update(this, 'update', conditions, doc, options, callback);
};

/**
 * 声明且（/或）执行当前查询为 updateMany() 操作。不同于
 * `update()` 的是， MongoDB 会忽略 `multi` 选项，更新 _所有_ 匹配
 * `criteria` 的文档（而非只是第一条）。
 *
 * **注意** updateMany _不会_ 触发 update 中间件。可以用 `pre('updateMany')`
 * 和 `post('updateMany')` 代替。
 *
 * 这个函数触发以下中间件
 *
 * - `updateMany()`
 *
 * @param {Object} [criteria]
 * @param {Object} [doc] the update command
 * @param {Object} [options]
 * @param {Boolean} [options.multipleCastError] 默认情况下，mongoose 只返回 query 转换中报的第一个错。激活该选项会聚合转换中所有的报错。
 * @param {Function} [callback] 可选，形参是 (error, writeOpResult)
 * @return {Query} this
 * @see Model.update #model_Model.update
 * @see update http://docs.mongodb.org/manual/reference/method/db.collection.update/
 * @see writeOpResult http://mongodb.github.io/node-mongodb-native/2.2/api/Collection.html#~WriteOpResult
 * @api public
 */

Query.prototype.updateMany = function(conditions, doc, options, callback) {
  if (typeof options === 'function') {
    // .update(conditions, doc, callback)
    callback = options;
    options = null;
  } else if (typeof doc === 'function') {
    // .update(doc, callback);
    callback = doc;
    doc = conditions;
    conditions = {};
    options = null;
  } else if (typeof conditions === 'function') {
    // .update(callback)
    callback = conditions;
    conditions = undefined;
    doc = undefined;
    options = undefined;
  } else if (typeof conditions === 'object' && !doc && !options && !callback) {
    // .update(doc)
    doc = conditions;
    conditions = undefined;
    options = undefined;
    callback = undefined;
  }

  return _update(this, 'updateMany', conditions, doc, options, callback);
};

/**
 * Declare and/or execute this query as an updateOne() operation. Same as
 * `update()`, except MongoDB will update _only_ the first document that
 * matches `criteria` regardless of the value of the `multi` option.
 *
 * **Note** updateOne will _not_ fire update middleware. Use `pre('updateOne')`
 * and `post('updateOne')` instead.
 *
 * 这个函数触发以下中间件
 *
 * - `updateOne()`
 *
 * @param {Object} [criteria]
 * @param {Object} [doc] the update command
 * @param {Object} [options]
 @param {Boolean} [options.multipleCastError] by default, mongoose only returns the first error that occurred in casting the query. Turn on this option to aggregate all the cast errors.
 * @param {Function} [callback] params are (error, writeOpResult)
 * @return {Query} this
 * @see Model.update #model_Model.update
 * @see update http://docs.mongodb.org/manual/reference/method/db.collection.update/
 * @see writeOpResult http://mongodb.github.io/node-mongodb-native/2.2/api/Collection.html#~WriteOpResult
 * @api public
 */

Query.prototype.updateOne = function(conditions, doc, options, callback) {
  if (typeof options === 'function') {
    // .update(conditions, doc, callback)
    callback = options;
    options = null;
  } else if (typeof doc === 'function') {
    // .update(doc, callback);
    callback = doc;
    doc = conditions;
    conditions = {};
    options = null;
  } else if (typeof conditions === 'function') {
    // .update(callback)
    callback = conditions;
    conditions = undefined;
    doc = undefined;
    options = undefined;
  } else if (typeof conditions === 'object' && !doc && !options && !callback) {
    // .update(doc)
    doc = conditions;
    conditions = undefined;
    options = undefined;
    callback = undefined;
  }

  return _update(this, 'updateOne', conditions, doc, options, callback);
};

/**
 * Declare and/or execute this query as a replaceOne() operation. Same as
 * `update()`, except MongoDB will replace the existing document and will
 * not accept any atomic operators (`$set`, etc.)
 *
 * **Note** replaceOne will _not_ fire update middleware. Use `pre('replaceOne')`
 * and `post('replaceOne')` instead.
 *
 * 这个函数触发以下中间件
 *
 * - `replaceOne()`
 *
 * @param {Object} [criteria]
 * @param {Object} [doc] the update command
 * @param {Object} [options]
 * @param {Function} [callback] 可选 回调参数是 (error, writeOpResult)
 * @return {Query} this
 * @see Model.update #model_Model.update
 * @see update http://docs.mongodb.org/manual/reference/method/db.collection.update/
 * @see writeOpResult http://mongodb.github.io/node-mongodb-native/2.2/api/Collection.html#~WriteOpResult
 * @api public
 */

Query.prototype.replaceOne = function(conditions, doc, options, callback) {
  if (typeof options === 'function') {
    // .update(conditions, doc, callback)
    callback = options;
    options = null;
  } else if (typeof doc === 'function') {
    // .update(doc, callback);
    callback = doc;
    doc = conditions;
    conditions = {};
    options = null;
  } else if (typeof conditions === 'function') {
    // .update(callback)
    callback = conditions;
    conditions = undefined;
    doc = undefined;
    options = undefined;
  } else if (typeof conditions === 'object' && !doc && !options && !callback) {
    // .update(doc)
    doc = conditions;
    conditions = undefined;
    options = undefined;
    callback = undefined;
  }

  this.setOptions({ overwrite: true });
  return _update(this, 'replaceOne', conditions, doc, options, callback);
};

/*!
 * Internal helper for update, updateMany, updateOne, replaceOne
 */

function _update(query, op, filter, doc, options, callback) {
  // make sure we don't send in the whole Document to merge()
  query.op = op;
  filter = utils.toObject(filter);
  doc = doc || {};

  var oldCb = callback;
  if (oldCb) {
    if (typeof oldCb === 'function') {
      callback = function(error, result) {
        oldCb(error, result ? result.result : {ok: 0, n: 0, nModified: 0});
      };
    } else {
      throw new Error('Invalid callback() argument.');
    }
  }

  // strict is an option used in the update checking, make sure it gets set
  if (options) {
    if ('strict' in options) {
      query._mongooseOptions.strict = options.strict;
    }
  }

  if (!(filter instanceof Query) &&
      filter != null &&
      filter.toString() !== '[object Object]') {
    query.error(new ObjectParameterError(filter, 'filter', op));
  } else {
    query.merge(filter);
  }

  if (utils.isObject(options)) {
    query.setOptions(options);
  }

  query._mergeUpdate(doc);

  // Hooks
  if (callback) {
    if (op === 'update') {
      query._execUpdate(callback);
      return query;
    }
    query['_' + op](callback);
    return query;
  }

  return Query.base[op].call(query, filter, doc, options, callback);
}

/**
 * Executes the query
 *
 * ####示例s:
 *
 *     var promise = query.exec();
 *     var promise = query.exec('update');
 *
 *     query.exec(callback);
 *     query.exec('find', callback);
 *
 * @param {String|Function} [operation]
 * @param {Function} [callback] optional params depend on the function being called
 * @return {Promise}
 * @api public
 */

Query.prototype.exec = function exec(op, callback) {
  var _this = this;

  if (typeof op === 'function') {
    callback = op;
    op = null;
  } else if (typeof op === 'string') {
    this.op = op;
  }

  if (callback != null) {
    callback = this.model.$wrapCallback(callback);
  }

  return utils.promiseOrCallback(callback, (cb) => {
    if (!_this.op) {
      cb();
      return;
    }

    this[this.op].call(this, (error, res) => {
      if (error) {
        cb(error);
        return;
      }
      cb(null, res);
    });
  });
};

/**
 * Executes the query returning a `Promise` which will be
 * resolved with either the doc(s) or rejected with the error.
 *
 * @param {Function} [resolve]
 * @param {Function} [reject]
 * @return {Promise}
 * @api public
 */

Query.prototype.then = function(resolve, reject) {
  return this.exec().then(resolve, reject);
};

/**
 * Executes the query returning a `Promise` which will be
 * resolved with either the doc(s) or rejected with the error.
 * Like `.then()`, but only takes a rejection handler.
 *
 * @param {Function} [reject]
 * @return {Promise}
 * @api public
 */

Query.prototype.catch = function(reject) {
  return this.exec().then(null, reject);
};

/*!
 * Casts obj for an update command.
 *
 * @param {Object} obj
 * @return {Object} obj after casting its values
 * @api private
 */

Query.prototype._castUpdate = function _castUpdate(obj, overwrite) {
  var strict;
  if ('strict' in this._mongooseOptions) {
    strict = this._mongooseOptions.strict;
  } else if (this.schema && this.schema.options) {
    strict = this.schema.options.strict;
  } else {
    strict = true;
  }

  var omitUndefined = false;
  if ('omitUndefined' in this._mongooseOptions) {
    omitUndefined = this._mongooseOptions.omitUndefined;
  }

  return castUpdate(this.schema, obj, {
    overwrite: overwrite,
    strict: strict,
    omitUndefined
  }, this);
};

/*!
 * castQuery
 * @api private
 */

function castQuery(query) {
  try {
    return query.cast(query.model);
  } catch (err) {
    return err;
  }
}

/*!
 * castDoc
 * @api private
 */

function castDoc(query, overwrite) {
  try {
    return query._castUpdate(query._update, overwrite);
  } catch (err) {
    return err;
  }
}

/**
 * Specifies paths which should be populated with other documents.
 *
 * ####示例:
 *
 *     Kitten.findOne().populate('owner').exec(function (err, kitten) {
 *       console.log(kitten.owner.name) // Max
 *     })
 *
 *     Kitten.find().populate({
 *         path: 'owner'
 *       , select: 'name'
 *       , match: { color: 'black' }
 *       , options: { sort: { name: -1 }}
 *     }).exec(function (err, kittens) {
 *       console.log(kittens[0].owner.name) // Zoopa
 *     })
 *
 *     // alternatively
 *     Kitten.find().populate('owner', 'name', null, {sort: { name: -1 }}).exec(function (err, kittens) {
 *       console.log(kittens[0].owner.name) // Zoopa
 *     })
 *
 * Paths are populated after the query executes and a response is received. A separate query is then executed for each path specified for population. After a response for each query has also been returned, the results are passed to the callback.
 *
 * @param {Object|String} path either the path to populate or an object specifying all parameters
 * @param {Object|String} [select] Field selection for the population query
 * @param {Model} [model] The model you wish to use for population. If not specified, populate will look up the model by the name in the Schema's `ref` field.
 * @param {Object} [match] Conditions for the population query
 * @param {Object} [options] Options for the population query (sort, etc)
 * @see population ./populate.html
 * @see Query#select #query_Query-select
 * @see Model.populate #model_Model.populate
 * @return {Query} this
 * @api public
 */

Query.prototype.populate = function() {
  if (arguments.length === 0) {
    return this;
  }

  var i;

  var res = utils.populate.apply(null, arguments);

  // Propagate readPreference from parent query, unless one already specified
  if (this.options && this.options.readPreference != null) {
    for (i = 0; i < res.length; ++i) {
      if (!res[i].options || res[i].options.readPreference == null) {
        res[i].options = res[i].options || {};
        res[i].options.readPreference = this.options.readPreference;
      }
    }
  }

  var opts = this._mongooseOptions;

  if (!utils.isObject(opts.populate)) {
    opts.populate = {};
  }

  var pop = opts.populate;

  for (i = 0; i < res.length; ++i) {
    var path = res[i].path;
    if (pop[path] && pop[path].populate && res[i].populate) {
      res[i].populate = pop[path].populate.concat(res[i].populate);
    }
    pop[res[i].path] = res[i];
  }

  return this;
};

/**
 * Casts this query to the schema of `model`
 *
 * ####注意
 *
 * If `obj` is present, it is cast instead of this query.
 *
 * @param {Model} model
 * @param {Object} [obj]
 * @return {Object}
 * @api public
 */

Query.prototype.cast = function(model, obj) {
  obj || (obj = this._conditions);

  try {
    return cast(model.schema, obj, {
      upsert: this.options && this.options.upsert,
      strict: (this.options && 'strict' in this.options) ?
        this.options.strict :
        (model.schema.options && model.schema.options.strict),
      strictQuery: (this.options && this.options.strictQuery) ||
        (model.schema.options && model.schema.options.strictQuery)
    }, this);
  } catch (err) {
    // CastError, assign model
    if (typeof err.setModel === 'function') {
      err.setModel(model);
    }
    throw err;
  }
};

/**
 * Casts selected field arguments for field selection with mongo 2.2
 *
 *     query.select({ ids: { $elemMatch: { $in: [hexString] }})
 *
 * @param {Object} fields
 * @see https://github.com/Automattic/mongoose/issues/1091
 * @see http://docs.mongodb.org/manual/reference/projection/elemMatch/
 * @api private
 */

Query.prototype._castFields = function _castFields(fields) {
  var selected,
      elemMatchKeys,
      keys,
      key,
      out,
      i;

  if (fields) {
    keys = Object.keys(fields);
    elemMatchKeys = [];
    i = keys.length;

    // collect $elemMatch args
    while (i--) {
      key = keys[i];
      if (fields[key].$elemMatch) {
        selected || (selected = {});
        selected[key] = fields[key];
        elemMatchKeys.push(key);
      }
    }
  }

  if (selected) {
    // they passed $elemMatch, cast em
    try {
      out = this.cast(this.model, selected);
    } catch (err) {
      return err;
    }

    // apply the casted field args
    i = elemMatchKeys.length;
    while (i--) {
      key = elemMatchKeys[i];
      fields[key] = out[key];
    }
  }

  return fields;
};

/**
 * Applies schematype selected options to this query.
 * @api private
 */

Query.prototype._applyPaths = function applyPaths() {
  this._fields = this._fields || {};
  helpers.applyPaths(this._fields, this.model.schema);
  selectPopulatedFields(this);
};

/**
 * Returns a wrapper around a [mongodb driver cursor](http://mongodb.github.io/node-mongodb-native/2.1/api/Cursor.html).
 * A QueryCursor exposes a Streams3 interface, as well as a `.next()` function.
 *
 * The `.cursor()` function triggers pre find hooks, but **not** post find hooks.
 *
 * ####示例
 *
 *     // There are 2 ways to use a cursor. First, as a stream:
 *     Thing.
 *       find({ name: /^hello/ }).
 *       cursor().
 *       on('data', function(doc) { console.log(doc); }).
 *       on('end', function() { console.log('Done!'); });
 *
 *     // Or you can use `.next()` to manually get the next doc in the stream.
 *     // `.next()` returns a promise, so you can use promises or callbacks.
 *     var cursor = Thing.find({ name: /^hello/ }).cursor();
 *     cursor.next(function(error, doc) {
 *       console.log(doc);
 *     });
 *
 *     // Because `.next()` returns a promise, you can use co
 *     // to easily iterate through all documents without loading them
 *     // all into memory.
 *     co(function*() {
 *       const cursor = Thing.find({ name: /^hello/ }).cursor();
 *       for (let doc = yield cursor.next(); doc != null; doc = yield cursor.next()) {
 *         console.log(doc);
 *       }
 *     });
 *
 * ####Valid options
 *
 *   - `transform`: optional function which accepts a mongoose document. The return value of the function will be emitted on `data` and returned by `.next()`.
 *
 * @return {QueryCursor}
 * @param {Object} [options]
 * @see QueryCursor
 * @api public
 */

Query.prototype.cursor = function cursor(opts) {
  this._applyPaths();
  this._fields = this._castFields(this._fields);
  this.setOptions({ fields: this._fieldsForExec() });
  if (opts) {
    this.setOptions(opts);
  }

  try {
    this.cast(this.model);
  } catch (err) {
    return (new QueryCursor(this, this.options))._markError(err);
  }

  return new QueryCursor(this, this.options);
};

// the rest of these are basically to support older Mongoose syntax with mquery

/**
 * _DEPRECATED_ Alias of `maxScan`
 *
 * @deprecated
 * @see maxScan #query_Query-maxScan
 * @method maxscan
 * @memberOf Query
 */

Query.prototype.maxscan = Query.base.maxScan;

/**
 * Sets the tailable option (for use with capped collections).
 *
 * ####示例
 *
 *     query.tailable() // true
 *     query.tailable(true)
 *     query.tailable(false)
 *
 * ####注意
 *
 * 不能和 `distinct()` 一起使用
 *
 * @param {Boolean} bool defaults to true
 * @param {Object} [opts] options to set
 * @param {Number} [opts.numberOfRetries] if cursor is exhausted, retry this many times before giving up
 * @param {Number} [opts.tailableRetryInterval] if cursor is exhausted, wait this many milliseconds before retrying
 * @see tailable http://docs.mongodb.org/manual/tutorial/create-tailable-cursor/
 * @api public
 */

Query.prototype.tailable = function(val, opts) {
  // we need to support the tailable({ awaitdata : true }) as well as the
  // tailable(true, {awaitdata :true}) syntax that mquery does not support
  if (val && val.constructor.name === 'Object') {
    opts = val;
    val = true;
  }

  if (val === undefined) {
    val = true;
  }

  if (opts && typeof opts === 'object') {
    for (var key in opts) {
      if (key === 'awaitdata') {
        // For backwards compatibility
        this.options[key] = !!opts[key];
      } else {
        this.options[key] = opts[key];
      }
    }
  }

  return Query.base.tailable.call(this, val);
};

/**
 * Declares an intersects query for `geometry()`.
 *
 * ####示例
 *
 *     query.where('path').intersects().geometry({
 *         type: 'LineString'
 *       , coordinates: [[180.0, 11.0], [180, 9.0]]
 *     })
 *
 *     query.where('path').intersects({
 *         type: 'LineString'
 *       , coordinates: [[180.0, 11.0], [180, 9.0]]
 *     })
 *
 * ####注意:
 *
 * **MUST** be used after `where()`.
 *
 * ####注意:
 *
 * In Mongoose 3.7, `intersects` changed from a getter to a function. If you need the old syntax, use [this](https://github.com/ebensing/mongoose-within).
 *
 * @method intersects
 * @memberOf Query
 * @param {Object} [arg]
 * @return {Query} this
 * @see $geometry http://docs.mongodb.org/manual/reference/operator/geometry/
 * @see geoIntersects http://docs.mongodb.org/manual/reference/operator/geoIntersects/
 * @api public
 */

/**
 * Specifies a `$geometry` condition
 *
 * ####示例
 *
 *     var polyA = [[[ 10, 20 ], [ 10, 40 ], [ 30, 40 ], [ 30, 20 ]]]
 *     query.where('loc').within().geometry({ type: 'Polygon', coordinates: polyA })
 *
 *     // or
 *     var polyB = [[ 0, 0 ], [ 1, 1 ]]
 *     query.where('loc').within().geometry({ type: 'LineString', coordinates: polyB })
 *
 *     // or
 *     var polyC = [ 0, 0 ]
 *     query.where('loc').within().geometry({ type: 'Point', coordinates: polyC })
 *
 *     // or
 *     query.where('loc').intersects().geometry({ type: 'Point', coordinates: polyC })
 *
 * The argument is assigned to the most recent path passed to `where()`.
 *
 * ####注意:
 *
 * `geometry()` **must** come after either `intersects()` or `within()`.
 *
 * The `object` argument must contain `type` and `coordinates` properties.
 * - type {String}
 * - coordinates {Array}
 *
 * @method geometry
 * @memberOf Query
 * @param {Object} object Must contain a `type` property which is a String and a `coordinates` property which is an Array. See the examples.
 * @return {Query} this
 * @see $geometry http://docs.mongodb.org/manual/reference/operator/geometry/
 * @see http://docs.mongodb.org/manual/release-notes/2.4/#new-geospatial-indexes-with-geojson-and-improved-spherical-geometry
 * @see http://www.mongodb.org/display/DOCS/Geospatial+Indexing
 * @api public
 */

/**
 * Specifies a `$near` or `$nearSphere` condition
 *
 * These operators return documents sorted by distance.
 *
 * ####示例
 *
 *     query.where('loc').near({ center: [10, 10] });
 *     query.where('loc').near({ center: [10, 10], maxDistance: 5 });
 *     query.where('loc').near({ center: [10, 10], maxDistance: 5, spherical: true });
 *     query.near('loc', { center: [10, 10], maxDistance: 5 });
 *
 * @method near
 * @memberOf Query
 * @param {String} [path]
 * @param {Object} val
 * @return {Query} this
 * @see $near http://docs.mongodb.org/manual/reference/operator/near/
 * @see $nearSphere http://docs.mongodb.org/manual/reference/operator/nearSphere/
 * @see $maxDistance http://docs.mongodb.org/manual/reference/operator/maxDistance/
 * @see http://www.mongodb.org/display/DOCS/Geospatial+Indexing
 * @api public
 */

/*!
 * Overwriting mquery is needed to support a couple different near() forms found in older
 * versions of mongoose
 * near([1,1])
 * near(1,1)
 * near(field, [1,2])
 * near(field, 1, 2)
 * In addition to all of the normal forms supported by mquery
 */

Query.prototype.near = function() {
  var params = [];
  var sphere = this._mongooseOptions.nearSphere;

  // TODO refactor

  if (arguments.length === 1) {
    if (Array.isArray(arguments[0])) {
      params.push({center: arguments[0], spherical: sphere});
    } else if (typeof arguments[0] === 'string') {
      // just passing a path
      params.push(arguments[0]);
    } else if (utils.isObject(arguments[0])) {
      if (typeof arguments[0].spherical !== 'boolean') {
        arguments[0].spherical = sphere;
      }
      params.push(arguments[0]);
    } else {
      throw new TypeError('invalid argument');
    }
  } else if (arguments.length === 2) {
    if (typeof arguments[0] === 'number' && typeof arguments[1] === 'number') {
      params.push({center: [arguments[0], arguments[1]], spherical: sphere});
    } else if (typeof arguments[0] === 'string' && Array.isArray(arguments[1])) {
      params.push(arguments[0]);
      params.push({center: arguments[1], spherical: sphere});
    } else if (typeof arguments[0] === 'string' && utils.isObject(arguments[1])) {
      params.push(arguments[0]);
      if (typeof arguments[1].spherical !== 'boolean') {
        arguments[1].spherical = sphere;
      }
      params.push(arguments[1]);
    } else {
      throw new TypeError('invalid argument');
    }
  } else if (arguments.length === 3) {
    if (typeof arguments[0] === 'string' && typeof arguments[1] === 'number'
        && typeof arguments[2] === 'number') {
      params.push(arguments[0]);
      params.push({center: [arguments[1], arguments[2]], spherical: sphere});
    } else {
      throw new TypeError('invalid argument');
    }
  } else {
    throw new TypeError('invalid argument');
  }

  return Query.base.near.apply(this, params);
};

/**
 * _DEPRECATED_ Specifies a `$nearSphere` condition
 *
 * ####示例
 *
 *     query.where('loc').nearSphere({ center: [10, 10], maxDistance: 5 });
 *
 * **Deprecated.** Use `query.near()` instead with the `spherical` option set to `true`.
 *
 * ####示例
 *
 *     query.where('loc').near({ center: [10, 10], spherical: true });
 *
 * @deprecated
 * @see near() #query_Query-near
 * @see $near http://docs.mongodb.org/manual/reference/operator/near/
 * @see $nearSphere http://docs.mongodb.org/manual/reference/operator/nearSphere/
 * @see $maxDistance http://docs.mongodb.org/manual/reference/operator/maxDistance/
 */

Query.prototype.nearSphere = function() {
  this._mongooseOptions.nearSphere = true;
  this.near.apply(this, arguments);
  return this;
};

/**
 * Specifies a $polygon condition
 *
 * ####示例
 *
 *     query.where('loc').within().polygon([10,20], [13, 25], [7,15])
 *     query.polygon('loc', [10,20], [13, 25], [7,15])
 *
 * @method polygon
 * @memberOf Query
 * @param {String|Array} [path]
 * @param {Array|Object} [coordinatePairs...]
 * @return {Query} this
 * @see $polygon http://docs.mongodb.org/manual/reference/operator/polygon/
 * @see http://www.mongodb.org/display/DOCS/Geospatial+Indexing
 * @api public
 */

/**
 * Specifies a $box condition
 *
 * ####示例
 *
 *     var lowerLeft = [40.73083, -73.99756]
 *     var upperRight= [40.741404,  -73.988135]
 *
 *     query.where('loc').within().box(lowerLeft, upperRight)
 *     query.box({ ll : lowerLeft, ur : upperRight })
 *
 * @method box
 * @memberOf Query
 * @see $box http://docs.mongodb.org/manual/reference/operator/box/
 * @see within() Query#within #query_Query-within
 * @see http://www.mongodb.org/display/DOCS/Geospatial+Indexing
 * @param {Object} val
 * @param [Array] Upper Right Coords
 * @return {Query} this
 * @api public
 */

/*!
 * this is needed to support the mongoose syntax of:
 * box(field, { ll : [x,y], ur : [x2,y2] })
 * box({ ll : [x,y], ur : [x2,y2] })
 */

Query.prototype.box = function(ll, ur) {
  if (!Array.isArray(ll) && utils.isObject(ll)) {
    ur = ll.ur;
    ll = ll.ll;
  }
  return Query.base.box.call(this, ll, ur);
};

/**
 * Specifies a $center or $centerSphere condition.
 *
 * ####示例
 *
 *     var area = { center: [50, 50], radius: 10, unique: true }
 *     query.where('loc').within().circle(area)
 *     // alternatively
 *     query.circle('loc', area);
 *
 *     // spherical calculations
 *     var area = { center: [50, 50], radius: 10, unique: true, spherical: true }
 *     query.where('loc').within().circle(area)
 *     // alternatively
 *     query.circle('loc', area);
 *
 * New in 3.7.0
 *
 * @method circle
 * @memberOf Query
 * @param {String} [path]
 * @param {Object} area
 * @return {Query} this
 * @see $center http://docs.mongodb.org/manual/reference/operator/center/
 * @see $centerSphere http://docs.mongodb.org/manual/reference/operator/centerSphere/
 * @see $geoWithin http://docs.mongodb.org/manual/reference/operator/geoWithin/
 * @see http://www.mongodb.org/display/DOCS/Geospatial+Indexing
 * @api public
 */

/**
 * _DEPRECATED_ Alias for [circle](#query_Query-circle)
 *
 * **Deprecated.** Use [circle](#query_Query-circle) instead.
 *
 * @deprecated
 * @method center
 * @memberOf Query
 * @api public
 */

Query.prototype.center = Query.base.circle;

/**
 * _DEPRECATED_ Specifies a $centerSphere condition
 *
 * **Deprecated.** Use [circle](#query_Query-circle) instead.
 *
 * ####示例
 *
 *     var area = { center: [50, 50], radius: 10 };
 *     query.where('loc').within().centerSphere(area);
 *
 * @deprecated
 * @param {String} [path]
 * @param {Object} val
 * @return {Query} this
 * @see http://www.mongodb.org/display/DOCS/Geospatial+Indexing
 * @see $centerSphere http://docs.mongodb.org/manual/reference/operator/centerSphere/
 * @api public
 */

Query.prototype.centerSphere = function() {
  if (arguments[0] && arguments[0].constructor.name === 'Object') {
    arguments[0].spherical = true;
  }

  if (arguments[1] && arguments[1].constructor.name === 'Object') {
    arguments[1].spherical = true;
  }

  Query.base.circle.apply(this, arguments);
};

/**
 * Determines if field selection has been made.
 *
 * @method selected
 * @memberOf Query
 * @return {Boolean}
 * @api public
 */

/**
 * Determines if inclusive field selection has been made.
 *
 *     query.selectedInclusively() // false
 *     query.select('name')
 *     query.selectedInclusively() // true
 *
 * @method selectedInclusively
 * @memberOf Query
 * @return {Boolean}
 * @api public
 */

Query.prototype.selectedInclusively = function selectedInclusively() {
  return isInclusive(this._fields);
};

/**
 * Determines if exclusive field selection has been made.
 *
 *     query.selectedExclusively() // false
 *     query.select('-name')
 *     query.selectedExclusively() // true
 *     query.selectedInclusively() // false
 *
 * @method selectedExclusively
 * @memberOf Query
 * @return {Boolean}
 * @api public
 */

Query.prototype.selectedExclusively = function selectedExclusively() {
  if (!this._fields) {
    return false;
  }

  var keys = Object.keys(this._fields);
  if (keys.length === 0) {
    return false;
  }

  for (var i = 0; i < keys.length; ++i) {
    var key = keys[i];
    if (key === '_id') {
      continue;
    }
    if (this._fields[key] === 0 || this._fields[key] === false) {
      return true;
    }
  }

  return false;
};

/*!
 * Export
 */

module.exports = Query;
