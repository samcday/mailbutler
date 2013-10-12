/*
This plugins forwards mail destined for domains we are hosting to the relevant
recipient.
*/

var redis = require("../lib/redis");
var Address = require("./address").Address;

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
    var originalRcpt = txn.rcpt_to[0];
    connection.relaying = true;

    // So on the one hand, we *do* want to rewrite the envelope sender with an 
    // SRS address, but on the other hand we don't. SRS means we have to handle
    // more crap like bounces. It also means if we don't do a good enough job
    // filtering out spam then our relays can get blacklisted by Gmail. If
    // we leave the envelope sender as the original sender, then it means we
    // immediately fail SPF checks, however Gmail at least is intelligent and
    // will care a lot less about SPF checks on our forwarded mail if the 
    // recipient we forward to has added the forwarding address to their "Send
    // mail as" list. https://support.google.com/a/answer/175365?hl=en
    // Since our primary use-case for MVP is cheap-asses forwarding their email
    // Gmail, this is acceptable for now. Perhaps later we can investigate the
    // complexities of SRS, which at the very least would be handling bounces,
    // setting up spamd, and anything else that equates to me throwing myself
    // headlong into the insane fray that is the war on unsolicted email.
    // txn.mail_from = originalRcpt;

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
                next(!err ? OK : undefined);
            });
        }
        next();
    });
};
