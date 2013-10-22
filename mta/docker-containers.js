"use strict";

var _ = require("underscore"),
    q = require("q"),
    child_process = require("child_process"),
    net = require("net"),
    dockerode = require("dockerode"),
    temp = require("temp"),
    streamSplitter = require("stream-splitter"),
    JSONStream = require("JSONStream");

/*
TODO:
 * provide some kind of shutdown hook to ensure containers die when we do.
 * dockerode passes error info as second parameter when failures occur...
   q.ninvoke drops these on the floor and we don't get them in our fail 
   handlers, figure out how to fix this.
 * decouple creation from startup in API.
 */

// Make sure temporary files get cleaned up on exit.
temp.track();

// Determines the IP address for docker host. If we connected over TCP it's
// already known, otherwise we try and determine based on docker0 interface.
// TODO: os.networkInterfaces() times out and doesn't always return all ifaces..
function getDockerIp(ctx) {
    if(ctx.api._addr) {
        return q(ctx.api._addr);
    }
    var cmd = "ifconfig docker0";
    return q.ninvoke(child_process, "exec", cmd).then(function(output) {
        output = output.join("");
        var m = /inet addr:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(output);
        var res = m ? m[1] : null;
        if(!res) {
            throw new Error("Failed to determine docker host IP!");
        }
        ctx.api._addr = res;
        return res;
    });
}

function pipeOutputToLog(ctx, stream, transform) {
    var splitter = stream.pipe(streamSplitter("\n"));
    splitter.encoding = "utf8";
    splitter.on("token", function(token) {
        if(transform) {
            ctx.log(transform(token));
        }
        else {
            ctx.log(token);
        }
    });
}

// Promisifies the Container instances that dockerode gives us.
function promisifyContainer(container) {
    ["start", "stop", "wait", "inspect", "kill"].forEach(function(fn) {
        container[fn] = q.nbind(container[fn], container);
    });
    return container;
}

// Tars up whole project to temporary file and returns path to that file.
function createProjectArchive(ctx, projectRoot) {
    ctx.log("Archiving project root at ", projectRoot);
    return q.ninvoke(temp, "open", "mailbutler").then(function(tempFile) {
        var deferred = q.defer();
        var archivePath = tempFile.path;

        var cmd = "tar -C " + projectRoot + " -czvf " + archivePath + " .";
        child_process.exec(cmd, deferred.makeNodeResolver());
        return deferred.promise.then(function() {
            return archivePath;
        });
    });
}

// Performs the actual Docker build step with the provided archive.
function createProjectImage(ctx, archivePath, tag) {
    var deferred = q.defer();
    ctx.log("Building Docker container for application...");
    var opts = {
        t: tag,
        rm: true
    };
    ctx.docker.buildImage(archivePath, opts, function(err, stream) {
        if(err) {
            return deferred.reject(err);
        }
        pipeOutputToLog(ctx, stream);
        stream.on("end", function() {
            if(stream.statusCode != 200) {
                return deferred.reject(new Error("Couldn't create image."));
            }
            deferred.resolve();
        });
    });
    return deferred.promise;
}

// TODO: should support wait timeouts.
function waitForPorts(ctx, ports) {
    ctx.log("Waiting for container to become responsive...");
    return getDockerIp(ctx).then(function(remoteAddr) {
        var promises = [];
        ports.forEach(function(port) {
            promises.push(waitForPort(ctx, remoteAddr, port));
        });
        return q.all(promises);
    });
}

// Waits for port to accept connections.
function waitForPort(ctx, host, port) {
    var deferred = q.defer();

    var checkConnection = function() {
        var socket = net.connect({port: port, host: host}, function() {
            deferred.resolve();
        });
        socket.on("error", function() {
            setTimeout(checkConnection, 100);
        });
    };

    checkConnection();

    return deferred.promise;
}

function runContainer(ctx, image, ports, env, cmd, waitPorts) {
    env = _.map(env, function(v, k) {
        return k + "=" + v;
    });
    var opts = {
        Image: image,
        PortSpecs: ports,
        Env: env,
        Cmd: cmd
    };
    ctx.log("Creating container...");
    return q.ninvoke(ctx.api.docker, "createContainer", opts).then(function(container) {
        ctx.log("Starting container...");
        container = promisifyContainer(container);
        return container.start().then(function() {
            ctx.log("Container has started.");
            return wrapContainer(ctx, container);
        });
    }).then(function(wrappedContainer) {
        if(!waitPorts) {
            return wrappedContainer;
        }
        var ports = _.values(wrappedContainer.forwardedPorts);
        return waitForPorts(ctx, ports).thenResolve(wrappedContainer);
    }).then(function(wrappedContainer) {
        ctx.log("Container is running.");
        return wrappedContainer;
    });
}

// Pulls an image from Index, if it isn't present locally yet.
function pullImage(ctx, name) {
    var img = ctx.docker.getImage(name);
    return q.ninvoke(img, "inspect").fail(function(error) {
        ctx.log("Pulling image down from Docker Index...");
        return q.ninvoke(ctx.docker, "createImage", {
            fromImage: name
        }).then(function(stream) {
            var deferred = q.defer();

            // Only send an update for download progress at most every 1 
            // second per image being downloaded.
            var downloadNotifications = _.memoize(function(id) {
                return _.throttle(function(progress) {
                    ctx.log("Downloading " + id + ": ", progress);
                }, 1000, {trailing: false});
            });

            var completed = {};

            var jsonStream = stream.pipe(JSONStream.parse());
            jsonStream.on("data", function(update) {
                if(_.contains(["Downloading", "Download"], update.status)) {
                    if("complete" === update.progress) {
                        if(!completed[update.id]) {
                            completed[update.id] = true;
                            ctx.log("Download complete for " + update.id);
                        }
                    }
                    else {
                        downloadNotifications(update.id)(update.progress);
                    }
                }
                else {
                    if(update.progress) {
                        ctx.log(update.status, update.progress, "for", update.id);
                    }
                    else {
                        ctx.log(update.status);
                    }
                }
            });

            jsonStream.on("end", function() {
                deferred.resolve();
            });
            return deferred.promise;
        });
    });
}

// Wraps a container up in the return object we give callers.
function wrapContainer(ctx, container) {
    return container.inspect().then(function(data) {
        var forwardedPorts = data.NetworkSettings.PortMapping.Tcp;
        return {
            forwardedPorts: forwardedPorts,
            ip: data.NetworkSettings.IPAddress,
            gateway: data.NetworkSettings.Gateway,
            id: container.id,
            waitForPorts: function() {
                return waitForPorts(ctx, _.values(forwardedPorts));
            },
            stop: function(kill) {                
                if(kill) {
                    ctx.log("Killing container.");
                    return container.kill();
                }

                ctx.log("Stopping container...");
                return container.stop().then(function() {
                    ctx.log("Waiting for container to exit...");
                    return container.wait();
                }).then(function(result) {
                    ctx.log("Container has stopped.");
                    return result ? result.StatusCode : null;
                });
            }
        };
    });
}

function makeContext(api, prefix) {
    return {
        log: function() {
            var args = Array.prototype.slice.call(arguments, 0);
            args.unshift(prefix);
            api.log.apply(api, args);
        },
        docker: api.docker,
        api: api
    };
}

var baseOptions = ["ports", "env", "waitForPorts", "cmd"];

function builder(options, doneFn) {
    var o = {};
    o.options = {};
    o.run = function() {
        return doneFn(o.options);
    };
    options.forEach(function(opt) {
        o.options[opt] = undefined;
        o[opt] = function(val) {
            if(arguments.length) {
                o.options[opt] = val;
                return this;
            }
            else {
                return o.options[opt];
            }
        };
    });
    return o;
}

// Pulls a known image from docker image and runs it up.
function fromIndex(api, imageName) {
    return builder(baseOptions, function(opts) {
        var ctx = makeContext(api, imageName);
        return pullImage(ctx, imageName).then(function() {
            return runContainer(ctx, imageName, opts.ports, opts.env, opts.cmd, opts.waitForPorts);
        });
    });
}

// Tars up given root dir, ships it to Docker to build, then runs it up.
function fromProjectRoot(api, projectRoot, tag) {
    return builder(baseOptions, function(opts) {
        var ctx = makeContext(api, tag);
        return createProjectArchive(ctx, projectRoot).then(function(archivePath) {
            return createProjectImage(ctx, archivePath, tag);
        }).then(function() {
            return runContainer(ctx, tag, opts.ports, opts.env, opts.cmd, opts.waitForPorts);
        });
    });
}

function connect(settings, remoteAddr) {
    var api = {
        docker: new dockerode(settings),
        log: function(tag) {
            var args = Array.prototype.slice.call(arguments, 1);
            args.unshift("[" + tag + "]");
            console.log.apply(null, args);
        },
        _addr: remoteAddr
    };
    api.fromIndex = _.partial(fromIndex, api);
    api.fromProjectRoot = _.partial(fromProjectRoot, api);
    return api;
}

// Sets up a remote api  connection to Docker.
exports.connectSocket = function(socketPath) {
    return connect({socketPath: socketPath});
};

exports.connectTcp = function(host, port) {
    return connect({host: "http://" + host, port: port}, host);
};