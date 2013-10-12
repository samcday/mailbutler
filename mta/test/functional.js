"use strict";

var dockerode = require("dockerode"),
    os = require("os"),
    nodemailer = require("nodemailer"),
    temp = require("temp"),
    path = require("path"),
    child_process = require("child_process"),
    q = require("q"),
    chai = require("chai"),
    request = require("request"),
    redis = require("predis");

chai.should();

var docker = new dockerode({socketPath: "/var/run/docker.sock"});

// Make sure temporary files get cleaned up on exit.
temp.track();

// Promisify some stuff.
var tempOpen = q.denodeify(temp.open),
    childProcessExec = q.denodeify(child_process.exec);

var redisImageId = "johncosta/redis",
    mailcatcherImageId = "fgrehm/ventriloquist-mailcatcher";

var applicationContainer = null,
    redisContainer = null,
    mailcatcherContainer = null,
    applicationPort = null,
    redisPort = null,
    mailcatcherMailPort = null,
    mailcatcherWebPort = null;

var transport = null,
    redisClient = null;

function getInterfaceIpv4Address(ifaceName) {
    var iface = os.networkInterfaces()[ifaceName];
    if(!iface) return undefined;
    var sub = iface.filter(function(it) { return it.family == "IPv4"; }).pop();
    return sub ? sub.address : undefined;
}

var dockerIp = getInterfaceIpv4Address("docker0");

// Promisifies the Container instances that dockerode gives us.
function promisifyContainer(container) {
    ["start", "stop", "inspect"].forEach(function(fn) {
        container[fn] = q.nbind(container[fn], container);
    });
    return container;
}

// Tars up whole project to temporary file and returns path to that file.
function createProjectArchive() {
    return tempOpen("mailbutler").then(function(info) {
        var deferred = q.defer();
        var archivePath = info.path;
        var projectRoot = path.resolve(__dirname, "..");

        var cmd = "tar -C " + projectRoot + " -czvf " + archivePath + " .";
        child_process.exec(cmd, function(err) {
            if(err) {
                return deferred.reject(err);
            }
            deferred.resolve(archivePath);
        });
        return deferred.promise;
    });
}

function createProjectImage(archivePath) {
    var deferred = q.defer();
    console.log("Building Docker container for application...");
    var opts = {
        t: "mailbutler/mta",
        rm: true
    };
    docker.buildImage(archivePath, opts, function(err, stream) {
        if(err) {
            return deferred.reject(err);
        }
        stream.pipe(process.stdout);
        stream.on("end", function() {
            if(stream.statusCode != 200) {
                return deferred.reject(new Error("Couldn't create image."));
            }
            deferred.resolve();
        });
    });
    return deferred.promise;
}

function pullContainer(name) {
    return q.ninvoke(docker, "createImage", {
        fromImage: name
    }).then(function(stream) {
        stream.pipe(process.stdout);
        var deferred = q.defer();
        stream.on("end", function() {
            deferred.resolve();
        });
        return deferred.promise;
    });
}

function runContainer(opts) {
    return q.ninvoke(docker, "createContainer", opts).then(function(container) {
        return promisifyContainer(container).start().then(function() {
            return container;
        });
    });
}

function stopContainer(container) {
    if(!container) { return; }
    return container.stop();
}

function runRedisContainer() {
    return pullContainer(redisImageId).then(function() {
        console.log("Starting redis container...");
        var opts = {
            Image: redisImageId,
            PortSpecs: ["6379"]
        };
        return runContainer(opts).then(function(container) {
            console.log("Redis container started.");
            redisContainer = container;

            return redisContainer.inspect().then(function(data) {
                redisPort = data.NetworkSettings.PortMapping.Tcp["6379"];
            });
        });
    });
}

function runMtaContainer() {
    console.log("Starting Docker container for application...");
    var opts = {
        Image: "mailbutler/mta",
        PortSpecs: ["25"],
        Env: [
            "REDIS_URL=redis://" + dockerIp + ":" + redisPort
        ]
    };
    return runContainer(opts).then(function(container) {
        applicationContainer = container;

        return applicationContainer.inspect().then(function(data) {
            applicationPort = data.NetworkSettings.PortMapping.Tcp["25"];
        });
    });
}

function runMailcatcherContainer() {
    return pullContainer(mailcatcherImageId).then(function() {
        console.log("Starting Mailcatcher container...");
        var opts = {
            Image: mailcatcherImageId,
            PortSpecs: ["1025", "1080"]
        };
        return runContainer(opts).then(function(container) {
            mailcatcherContainer = container;

            return mailcatcherContainer.inspect().then(function(data) {
                mailcatcherWebPort = data.NetworkSettings.PortMapping.Tcp["1080"];
                mailcatcherMailPort = data.NetworkSettings.PortMapping.Tcp["1025"];
            });
        });
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

describe("Mailbutler MTA", function() {
    before(function(done) {
        this.timeout(0);

        runRedisContainer()
            .then(runMailcatcherContainer)
            .then(createProjectArchive)
            .then(createProjectImage)
            .then(runMtaContainer)
            .then(function() {
                transport = nodemailer.createTransport("SMTP", {
                    host: "localhost",
                    port: applicationPort
                });

                redisClient = redis.createClient({port: redisPort});
            })
            .nodeify(done);
    });

    after(function(done) {
        this.timeout(0);

        q.allSettled([
            stopContainer(redisContainer),
            stopContainer(applicationContainer),
            stopContainer(mailcatcherContainer)
        ]).nodeify(done);
    });

    afterEach(function(done) {
        q(redisClient.flushdb())
            .nodeify(done);
    });

    it("should not accept emails for unhandled domains", function(done) {
        sendTestEmail("foo@test.com", "test@noexists.com")
            .then(function() {
                done(new Error("Should have been an error delivering mail."));
            })
            .fail(function(err) {
                done();
            });
    });

    // it("handled default routing correctly", function(done) {
    //     redisClient.set("def:validdomain.com");
    // });
});
