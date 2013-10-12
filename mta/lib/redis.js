var redis = require("redis");
var url = require("url");

var redisUrl = url.parse(process.env.REDIS_URL);
var opts = {};
if(redisUrl.auth) opts.auth_pass = redisUrl.auth.split(":")[0];
module.exports = redis.createClient(redisUrl.port, redisUrl.hostname, opts);
