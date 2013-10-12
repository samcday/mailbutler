"use strict";

var docker = require("docker.io")({socketPath: "/var/run/docker.sock"});
var temp = require("temp");
var path = require("path");
var child_process = require("child_process");
var Q = require("q");

// Make sure temporary files get cleaned up on exit.
temp.track();

// Promisify some stuff.
var tempOpen = Q.denodeify(temp.open);
var childProcessExec = Q.denodeify(child_process.exec);

// Tars up whole project to temporary file and returns path to that file.
function createProjectArchive() {
    return tempOpen("mailbutler").then(function(info) {
        var deferred = Q.defer();
        var archivePath = info.path;
        var projectRoot = path.resolve(__dirname, "..");
        console.log(projectRoot);
        child_process.exec("tar -C " + projectRoot + " -czvf " + archivePath + " .", function(err) {
            if(err) {
                return deferred.reject(err);
            }
            deferred.resolve(archivePath);
        });
        return deferred.promise;
    });
}

describe("Mailbutler MTA", function() {
    before(function(done) {
        createProjectArchive().then(function(archivePath) {
            docker.containers.create(archivePath, {}, function() {
                console.log(arguments);
                done();
            });
        });
    });

    it("dummy", function() {
        return true;
    });
});