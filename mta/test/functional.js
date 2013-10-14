"use strict";

/*
TODO:
 * Mailcatcher is a bit slow to startup / shutdown. Seek alternatives.
 * nodemailer transport might be retrying emails that we *want* to fail,
   look into this.
 * predis is dodgy and console.logs connection / error messages. Replace it.
*/

var _ = require("underscore"),
    dockerode = require("dockerode"),
    nodemailer = require("nodemailer"),
    dockerContainers = require("../docker-containers"),
    path = require("path"),
    child_process = require("child_process"),
    q = require("q"),
    chai = require("chai"),
    request = require("request"),
    redis = require("predis");

chai.should();
request = request.defaults({json: true});

var containers = dockerContainers.connectSocket("/var/run/docker.sock");

var redisImageId = "johncosta/redis",
    mailcatcherImageId = "samcday/mailcatcher";

var applicationContainer = null,
    redisContainer = null,
    mailcatcherContainer = null;

var redisUrl = null,
    mailcatcherUrl = null;

var transport = null,
    redisClient = null;

function runRedisContainer() {
    return containers.fromIndex(redisImageId)
        .ports(["6379"])
        .waitForPorts(true)
        .run().then(function(container) {
            redisContainer = container;
            redisUrl = "redis://" + container.ip + ":6379";
            redisClient = redis.createClient({
                server: container.ip,
                port: 6379
            });
        });
}

function runMtaContainer() {
    var projectRoot = path.resolve(__dirname, "..");
    var ports = ["25"];
    var env = {
        REDIS_URL: redisUrl
    };
    return containers.fromProjectRoot(projectRoot, "mailbutler/mta")
        .ports(ports)
        .env(env)
        .waitForPorts(true)
        .run().then(function(container) {
            applicationContainer = container;
        });
}

function runMailcatcherContainer() {
    return containers.fromIndex(mailcatcherImageId)
        .ports(["25", "80"])
        .waitForPorts(true)
        .run().then(function(container) {
            mailcatcherContainer = container;
            mailcatcherUrl = "http://" + container.gateway + ":" +
                             container.forwardedPorts["80"];
        });
}

function sendTestEmail(from, to) {
    var message = {
        from: from,
        to: to,
        subject: "Test email",
        text: "foo"
    };

    return q.ninvoke(transport, "sendMail", message);
}

function clearMailcatcher() {
    var deferred = q.defer();
    request.del(mailcatcherUrl + "/messages", deferred.makeNodeResolver());
    return deferred.promise;
}

function waitForEmailFrom(rcpt) {
    var deferred = q.defer();

    function checkMail() {
        request.get(mailcatcherUrl + "/messages", function(err, data) {
            if(err) {
                console.log("Nah it's fucked.");
                return deferred.reject(err);
            }

        });
    }

    checkMail();

    return deferred.promise;
}

describe("Mailbutler MTA", function() {
    before(function(done) {
        this.timeout(0);

        q.all([
            // MTA needs Redis to come up, so we can't parallelize it as much.
            runRedisContainer().then(runMtaContainer),
            runMailcatcherContainer()
        ]).then(function() {
            console.log("Hmmm.");
            transport = nodemailer.createTransport("SMTP", {
                host: applicationContainer.ip,
                port: 25
            });
        })
        .nodeify(done);
    });

    after(function(done) {
        this.timeout(0);
        console.log("Shutting down all containers.");
        q.allSettled([
            redisContainer.stop(),
            applicationContainer.stop(),
            mailcatcherContainer.stop(true)
        ]).nodeify(done);
    });

    afterEach(function(done) {
        q.all([
            q(redisClient.flushdb()),
            clearMailcatcher
        ]).nodeify(done);
    });

    it("should not accept emails for unhandled domains", function(done) {
        sendTestEmail("orig@rcpt.com", "test@noexists.com")
            .then(function() {
                done(new Error("Should have been an error delivering mail."));
            })
            .fail(function(err) {
                done();
            });
    });

    /*it("handles default routing correctly", function(done) {
        q(redisClient.set("def:validdomain.com", "foo@bar.com")
            .then(function() {
                console.log("1");
                return redisClient.sadd("domains", "validdomain.com");
            })
            .then(function() {
                console.log("2");
                return sendTestEmail("orig@rcpt.com", "dst@validdomain.com");
            })
            .then(function() {
                console.log("3");
                return waitForEmailFrom("orig@rcpt.com");
            })
            .then(function(mail) {
                console.log("4");
                console.log(mail);
            }))
            .nodeify(done);
    });*/
});
