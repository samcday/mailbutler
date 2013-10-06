var Address = require('./address').Address;

var newRcpt = new Address("sam.c.day.throwaway", "gmail.com");

exports.hook_data_post = function(next, connection, params) {
    connection.relaying = true;

    var txn = connection.transaction;
    var originalRcpt = txn.rcpt_to[0];
    txn.rcpt_to[0] = newRcpt;
    txn.add_header("X-Forwarded-For", newRcpt.toString() + " " + originalRcpt.toString());
    txn.add_header("X-Forwarded-To", newRcpt.toString());
    txn.add_header("Resent-To", newRcpt.toString());
    txn.add_header("Resent-From", originalRcpt.toString());

    next();
};
