"use strict";

var dockerode = require("dockerode"),
    os = require("os"),
    nodemailer = require("nodemailer"),
    temp = require("temp"),
    path = require("path"),
    child_process = require("child_process"),
    Q = require("q"),
    chai = require("chai");

chai.should();

var docker = new dockerode({socketPath: "/var/run/docker.sock"});

// Make sure temporary files get cleaned up on exit.
temp.track();

// Promisify some stuff.
var tempOpen = Q.denodeify(temp.open),
    childProcessExec = Q.denodeify(child_process.exec);

var redisImageId = "johncosta/redis";

var applicationContainer = null,
    redisContainer = null,
    applicationPort = null,
    redisPort = null;

var transport = null;

function getInterfaceIpv4Address(ifaceName) {
    var iface = os.networkInterfaces()[ifaceName];
    if(!iface) return undefined;
    var sub = iface.filter(function(it) { return it.family == "IPv4"; }).pop();
    return sub ? sub.address : undefined;
}

// Promisifies the Container instances that dockerode gives us.
function promisifyContainer(container) {
    ["start", "stop", "inspect"].forEach(function(fn) {
        container[fn] = Q.nbind(container[fn], container);
    });
    return container;
}

// Tars up whole project to temporary file and returns path to that file.
function createProjectArchive() {
    return tempOpen("mailbutler").then(function(info) {
        var deferred = Q.defer();
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
    var deferred = Q.defer();
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

function runContainer(opts) {
    return Q.ninvoke(docker, "createContainer", opts).then(function(container) {
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
}

function runMtaContainer() {
    console.log("Starting Docker container for application...");
    var opts = {
        Image: "mailbutler/mta",
        PortSpecs: ["25"],
        Env: [
            "REDIS_URL=redis://" + getInterfaceIpv4Address("docker0") + ":" + redisPort
        ]
    };
    return runContainer(opts).then(function(container) {
        applicationContainer = container;

        return applicationContainer.inspect().then(function(data) {
            applicationPort = data.NetworkSettings.PortMapping.Tcp["25"];
        });
    });
}

function createSmtpTransport() {
    transport = nodemailer.createTransport("SMTP", {
        host: "localhost",
        port: applicationPort
    });
}

function sendTestEmail(from, to) {
    var message = {
        from: from,
        to: to,
        subject: "Test email",
        text: "foo"
    };

    return Q.ninvoke(transport, "sendMail", message);
}

describe("Mailbutler MTA", function() {
    before(function(done) {
        this.timeout(0);

        runRedisContainer()
            .then(createProjectArchive)
            .then(createProjectImage)
            .then(runMtaContainer)
            .then(createSmtpTransport)
            .nodeify(done);
    });

    after(function(done) {
        this.timeout(0);

        Q.allSettled([
            stopContainer(redisContainer),
            stopContainer(applicationContainer)
        ]).nodeify(done);
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
});
