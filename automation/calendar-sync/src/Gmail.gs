/**
 * Gmail.gs — reading the mail a rule points at.
 *
 * Everything here is I/O; the parsing it feeds lives in Parse.gs and Extract.gs.
 */

/** Reply chains repeat old dates verbatim, which would resurrect stale events. */
var CS_QUOTE_MARKERS = [
  /^\s*>/,
  /^\s*On .+ wrote:\s*$/i,
  /^\s*-+\s*Original Message\s*-+\s*$/i,
  /^\s*-+\s*Forwarded message\s*-+\s*$/i,
  /^\s*From:\s.+@/i,
];

/** Drop everything from the first quoted-reply marker onward. */
function csStripQuotedText(body) {
  var lines = String(body == null ? '' : body).replace(/\r\n?/g, '\n').split('\n');
  for (var i = 0; i < lines.length; i++) {
    for (var j = 0; j < CS_QUOTE_MARKERS.length; j++) {
      if (CS_QUOTE_MARKERS[j].test(lines[i])) return lines.slice(0, i).join('\n');
    }
  }
  return lines.join('\n');
}

/** The display name out of `"Jane Doe" <jane@example.com>`, or the address. */
function csFromName(from) {
  var text = String(from == null ? '' : from).trim();
  var named = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(text);
  if (named) return named[1].trim();
  var bare = /<([^>]+)>/.exec(text);
  return bare ? bare[1] : text;
}

/** A rule's query, scoped to the lookback window so old mail is never back-filled. */
function csRuleQuery(rule) {
  return '(' + rule.query + ') newer_than:' + CONFIG.LOOKBACK_DAYS + 'd';
}

function csGetOrCreateLabel(name) {
  if (!name) return null;
  var label = GmailApp.getUserLabelByName(name);
  return label || GmailApp.createLabel(name);
}

/**
 * Every message a rule's query matches, oldest first.
 *
 * Messages, not threads: a roster thread can carry several weekly emails, and
 * each one needs parsing. Ordering oldest-first means that when two messages
 * describe the same event, the newest is applied last and wins.
 */
function csFetchMessages(rule) {
  var threads = GmailApp.search(csRuleQuery(rule), 0, CONFIG.MAX_THREADS_PER_RULE);
  var contexts = [];

  for (var t = 0; t < threads.length; t++) {
    var thread = threads[t];
    var messages = thread.getMessages();
    for (var m = 0; m < messages.length; m++) {
      var message = messages[m];
      var from = message.getFrom();
      contexts.push({
        subject: message.getSubject() || '',
        body: csStripQuotedText(message.getPlainBody() || ''),
        from: from,
        fromName: csFromName(from),
        threadId: thread.getId(),
        messageId: message.getId(),
        date: message.getDate(),
        permalink: 'https://mail.google.com/mail/u/0/#all/' + thread.getId(),
        thread: thread,
      });
    }
  }

  contexts.sort(function (a, b) { return a.date.getTime() - b.date.getTime(); });
  return contexts;
}

/**
 * Mark a thread so the automation's reach is visible in Gmail itself.
 *
 * Skipped under DRY_RUN: a rehearsal that reports writing nothing must not
 * leave labels behind, or a preview quietly changes the mailbox it previewed.
 */
function csLabelThread(thread, labelName) {
  if (CONFIG.DRY_RUN || !thread || !labelName) return;
  var label = csGetOrCreateLabel(labelName);
  if (label) thread.addLabel(label);
}

/** Send the run summary, if an address is configured. */
function csSendDigest(subject, body) {
  if (!CONFIG.DIGEST_EMAIL) return;
  MailApp.sendEmail(CONFIG.DIGEST_EMAIL, subject, body);
}
