/*
This plugins forwards mail destined for domains we are hosting to the relevant recipient.
*/

var SRS = require("srs.js");
var redis = require("../lib/redis");
var Address = require("./address").Address;

// TODO: proper secret ;)
var srsRewriter = new SRS({secret: "supersecret"});

var forwarderHost = "mailbutler.org";

function getForwardingAddress(rcpt, cb) {
    redis.get("dst:" + rcpt.address().toLowerCase(), function(err, address) {
        if(address) return cb(null, new Address(address));
        redis.get("def:" + rcpt.host.toLowerCase(), function(err, address) {
            return cb(err, new Address(address));
        });
    });
}

function setupForwarding(rcpt, connection, cb) {
    var txn = connection.transaction;
    // TODO: should probably be looking at more than just the first address right?
    var originalRcpt = txn.rcpt_to[0];
    connection.relaying = true;

    txn.mail_from = new Address(srsRewriter.forward(originalRcpt.user, originalRcpt.host), forwarderHost);

    getForwardingAddress(rcpt, function(err, newRcpt) {
        txn.rcpt_to[0] = newRcpt;
        txn.add_header("X-Forwarded-For", newRcpt + " " + originalRcpt);
        txn.add_header("X-Forwarded-To", newRcpt.toString());
        txn.add_header("Resent-To", newRcpt.toString());
        txn.add_header("Resent-From", originalRcpt.toString());

        cb(OK);
    });
}

exports.hook_rcpt = function(next, connection, params) {
    var rcpt = params[0];

    // If we're already relaying, it's because this is mail coming FROM one of
    // our users, rather than arriving TO them.
    if (connection.relaying || !rcpt.host) {
        return next();
    }

    connection.logdebug(this, "Checking if " + rcpt + " host is in host_lists");

    var domain = rcpt.host.toLowerCase();
    redis.sismember("domains", domain, function(err, val) {
        if(val) {
            return setupForwarding(rcpt, connection, function(err) {
                // TODO: should be soft bouncing here if there was an error.
                next(!err ? OK : undefined);
            });
        }
        next();
    });
};
