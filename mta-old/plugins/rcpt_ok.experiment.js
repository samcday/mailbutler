var Address = require('./address').Address;

var newRcpt = new Address("sam.c.day", "gmail.com");

exports.hook_data_post = function(next, connection, params) {
    connection.relaying = true;

    var txn = connection.transaction;
    var originalRcpt = txn.rcpt_to[0];
    txn.rcpt_to[0] = newRcpt;

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
    txn.add_header("X-Forwarded-For", newRcpt.toString() + " " + originalRcpt.toString());
    txn.add_header("X-Forwarded-To", newRcpt.toString());
    txn.add_header("Resent-To", newRcpt.toString());
    txn.add_header("Resent-From", originalRcpt.toString());

    next();
};
