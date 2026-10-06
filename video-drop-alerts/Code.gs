/**
 * Available alerts
 *
 * Sends a Telegram message within a minute of a new video showing up in the hub's
 * Available column, so it can be claimed straight away. Runs on Google's servers, so
 * nothing has to stay open.
 *
 * Setup steps are in README.md next to this file. In short: fill in CONFIG, then run setup().
 */

// ======== Fill these in ========
const CONFIG = {
  // The token @BotFather gave you in Telegram. It looks like 123456789:AAH...
  TELEGRAM_BOT_TOKEN: '',

  // The hub's web address, and the name and access code you log in to it with.
  HUB_URL: '',
  HUB_NAME: '',
  HUB_ACCESS_CODE: '',

  // How often to check, in minutes: 1, 5, 10, 15 or 30.
  CHECK_EVERY_MINUTES: 1,
};
// ===============================

const MAX_LISTED_ = 20; // longer lists are cut short so they fit in one Telegram message
const JSON_STRING_ = '"(?:[^"\\\\]|\\\\.)*"';

/**
 * Run once after filling in CONFIG. It prints an invite link: anyone who opens it and taps
 * Start gets alerts from then on, without running anything again. Running setup again is
 * safe, and needed after changing CHECK_EVERY_MINUTES.
 */
function setup() {
  checkInterval_();
  const store = PropertiesService.getScriptProperties();
  const saved = store.getProperties();

  // On the first setup, people who already pressed Start get alerts too. After that, people
  // join through the invite link (see acceptNewMembers_): a plain Start isn't enough.
  const bot = telegram_('getMe');
  const updates = saved.inviteCode ? [] : telegram_('getUpdates', {});
  const chats = mergeChats_(loadChats_(), updates.map(function (update) {
    const message = update.message || update.edited_message || update.channel_post ||
      update.my_chat_member;
    return message && message.chat && chatInfo_(message.chat);
  }).filter(Boolean));

  // Videos already in Available don't alert. Logging in fresh also checks the name and code.
  hubLogin_();
  const available = readAvailable_(fetchBoard_());

  const state = {
    chats: JSON.stringify(chats),
    available: JSON.stringify(available.map(function (card) { return card.id; })),
    botUsername: bot.username,
    inviteCode: saved.inviteCode || Utilities.getUuid().replace(/-/g, '').slice(0, 16),
  };
  if (updates.length) state.lastUpdateId = String(updates[updates.length - 1].update_id);
  store.setProperties(state);

  stop();
  ScriptApp.newTrigger('checkForNewVideos').timeBased().everyMinutes(CONFIG.CHECK_EVERY_MINUTES).create();

  const link = inviteLink_(state);
  const now = available.length === 0 ? 'Available is empty right now.'
    : available.length === 1 ? '1 video is in Available right now.'
    : available.length + ' videos are in Available right now.';
  if (chats.length) {
    const result = sendToChats_(
      '✅ <b>Available alerts are on</b>\nYou\'ll get a message here when a new video shows up in ' +
      'Available. ' + now + '\n\nTo add someone, send them this link:\n' + escapeHtml_(link),
      boardButtons_());
    if (!result.sent) {
      throw new Error('Alerts are switched on, but the test message to Telegram failed. Check the ' +
        'execution log, then run sendTestAlert.');
    }
  }
  console.log('Logged in to the hub as %s. %s', String(CONFIG.HUB_NAME).trim(), now);
  console.log(chats.length
    ? 'Alerts go to: ' + loadChats_().map(function (c) { return c.name; }).join(', ')
    : 'Nobody gets alerts yet.');
  console.log('Invite link. Anyone who opens it and taps Start gets alerts: %s', link);
}

/** Runs on the timer that setup() creates. */
function checkForNewVideos() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return; // the previous check is still running

  try {
    const store = PropertiesService.getScriptProperties();
    const saved = store.getProperties();
    if (!saved.available) throw new Error('Run setup first.');

    // Add people who opened the invite link. A Telegram hiccup here mustn't hold up alerts.
    try {
      acceptNewMembers_(saved);
    } catch (e) {
      console.error('Couldn\'t check the bot for new people: %s', e.message);
    }

    // A video counts as new when it wasn't in Available last time. That includes one that
    // an editor released back to Available.
    const cards = readAvailable_(fetchBoard_());
    const before = JSON.parse(saved.available);
    const fresh = cards.filter(function (card) { return before.indexOf(card.id) === -1; });

    let result = { delivered: true, failures: 0 };
    if (fresh.length) {
      result = sendToChats_(availableText_(fresh),
        fresh.length === 1 ? cardButtons_(fresh[0]) : boardButtons_());
    }

    // If the alert couldn't be sent, keep the old list, so these videos still count as new
    // on the next check and the alert is tried again.
    if (result.delivered) {
      store.setProperty('available', JSON.stringify(cards.map(function (card) { return card.id; })));
    }
    if (result.failures) {
      throw new Error(result.failures + ' Telegram message(s) failed. Details are in the log above.');
    }
  } finally {
    lock.releaseLock();
  }
}

/** Prints the invite link again. */
function showInviteLink() {
  const saved = PropertiesService.getScriptProperties().getProperties();
  if (!saved.inviteCode) throw new Error('Run setup first.');
  console.log('Invite link. Anyone who opens it and taps Start gets alerts: %s', inviteLink_(saved));
}

/** Sends a test message to everyone who gets alerts. */
function sendTestAlert() {
  const result = sendToChats_('🔔 <b>Test alert</b>\nAvailable alerts can reach you here.', boardButtons_());
  if (!result.sent) throw new Error('The test message failed. Details are in the log above.');
  console.log('Test alert sent to: %s', loadChats_().map(function (c) { return c.name; }).join(', '));
}

/** Switches the alerts off. Run setup() to switch them back on. */
function stop() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'checkForNewVideos') ScriptApp.deleteTrigger(trigger);
  });
}

// ---------- Alerts ----------

function availableText_(cards) {
  if (cards.length === 1) {
    return [
      '🆕 <b>New video in Available</b>',
      '<b>' + escapeHtml_(cards[0].title) + '</b>',
      escapeHtml_(cards[0].tags.join(' · ')),
    ].filter(Boolean).join('\n');
  }
  const lines = cards.slice(0, MAX_LISTED_).map(function (card) {
    const title = card.link
      ? '<a href="' + escapeHtml_(card.link) + '">' + escapeHtml_(card.title) + '</a>'
      : escapeHtml_(card.title);
    return '• ' + title + (card.tags.length ? ' · ' + escapeHtml_(card.tags.join(' · ')) : '');
  });
  if (cards.length > MAX_LISTED_) lines.push('…and ' + (cards.length - MAX_LISTED_) + ' more');
  return ['🆕 <b>' + cards.length + ' new videos in Available</b>'].concat(lines).join('\n');
}

function cardButtons_(card) {
  return (card.link ? [{ text: '▶️ Raw video', url: card.link }] : []).concat(boardButtons_());
}

function boardButtons_() {
  return [{ text: '📋 Open board', url: hubBase_() + '/board' }];
}

/**
 * Sends one message to every saved chat. It counts as delivered when at least one chat got it,
 * or when nobody can be retried. People who blocked the bot are dropped from the list.
 */
function sendToChats_(text, buttons) {
  const chats = loadChats_();
  if (!chats.length) {
    console.error('Nobody gets alerts. Send the invite link to whoever should (run showInviteLink to see it).');
    return { sent: 0, delivered: true, failures: 1 };
  }
  const keep = [];
  let sent = 0;
  let waiting = 0;
  let failures = 0;

  chats.forEach(function (chat) {
    const payload = { chat_id: chat.id, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (buttons.length) payload.reply_markup = { inline_keyboard: [buttons] };
    const res = telegramRaw_('sendMessage', payload);

    if (res.ok) {
      sent++;
      keep.push(chat);
      return;
    }
    failures++;
    const gone = res.code === 403 || (res.code === 400 && /chat not found/i.test(res.description));
    if (gone) {
      console.error('Removed %s from alerts: %s', chat.name, res.description);
      return;
    }
    keep.push(chat);
    if (res.code === 0 || res.code === 401 || res.code === 429 || res.code >= 500) waiting++;
    console.error('Telegram message to %s failed (%s): %s', chat.name, res.code, res.description);
  });

  if (keep.length !== chats.length) saveChats_(keep);
  if (!keep.length) {
    console.error('Nobody gets alerts any more. Send the invite link to whoever should (run showInviteLink to see it).');
  }
  return { sent: sent, delivered: sent > 0 || waiting === 0, failures: failures };
}

// ---------- The hub ----------

function hubBase_() {
  let url = String(CONFIG.HUB_URL).trim().replace(/\/+$/, '');
  if (!url) throw new Error('Fill in HUB_URL at the top of the script.');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url.replace(/\/(board|login|guide)$/, ''); // in case a page link was pasted
}

/** Logs in the way the hub's login form does, and saves the session cookie it hands back. */
function hubLogin_() {
  const name = String(CONFIG.HUB_NAME).trim();
  const code = String(CONFIG.HUB_ACCESS_CODE).trim();
  if (!name || !code) throw new Error('Fill in HUB_NAME and HUB_ACCESS_CODE at the top of the script.');

  // The form's hidden action field changes whenever the hub is updated, so read it each time.
  const form = UrlFetchApp.fetch(hubBase_() + '/login', { muteHttpExceptions: true });
  const action = form.getContentText().match(/name="(\$ACTION_ID_[0-9a-f]+)"/);
  if (!action) {
    throw new Error('Couldn\'t find the hub\'s login form (' + form.getResponseCode() + '). Check HUB_URL.');
  }

  const boundary = '----AvailableAlerts' + Utilities.getUuid().replace(/-/g, '');
  const body = [[action[1], ''], ['name', name], ['code', code], ['remember', 'on']].map(function (field) {
    return '--' + boundary + '\r\nContent-Disposition: form-data; name="' + field[0] + '"\r\n\r\n' +
      field[1] + '\r\n';
  }).join('') + '--' + boundary + '--\r\n';
  const response = UrlFetchApp.fetch(hubBase_() + '/login', {
    method: 'post',
    contentType: 'multipart/form-data; boundary=' + boundary,
    payload: body,
    followRedirects: false,
    muteHttpExceptions: true,
  });

  const headers = response.getAllHeaders();
  let setCookie = headers['Set-Cookie'] || headers['set-cookie'] || [];
  if (!Array.isArray(setCookie)) setCookie = [setCookie];
  const cookie = setCookie.map(function (c) { return String(c).split(';')[0].trim(); })
    .filter(Boolean).join('; ');
  if (!cookie) {
    throw new Error('The hub didn\'t accept HUB_NAME and HUB_ACCESS_CODE. Check them by logging in ' +
      'on the website.');
  }
  PropertiesService.getScriptProperties().setProperty('hubCookie', cookie);
  return cookie;
}

/** The board's page data. Logs in again when the saved session has run out. */
function fetchBoard_() {
  let cookie = PropertiesService.getScriptProperties().getProperty('hubCookie') || hubLogin_();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = UrlFetchApp.fetch(hubBase_() + '/board', {
      headers: { Cookie: cookie, RSC: '1' }, // RSC asks for the page data only, about half the size
      followRedirects: false,
      muteHttpExceptions: true,
    });
    const code = response.getResponseCode();
    const data = code === 200 ? pageData_(response.getContentText()) : '';
    if (data.indexOf('{"className":"board-column",') !== -1) return data;
    if (code === 429 || code >= 500) {
      throw new Error('The hub isn\'t answering right now (' + code + '). The next check will try again.');
    }
    if (attempt === 0) cookie = hubLogin_(); // most likely the session ran out
  }
  throw new Error('Couldn\'t open the board, even after logging in again. Has the hub changed?');
}

/** The page data, whether the hub sent it on its own or inside a full HTML page. */
function pageData_(text) {
  if (text.indexOf('self.__next_f.push(') === -1) return text;
  const parts = [];
  const pattern = new RegExp('self\\.__next_f\\.push\\(\\[1,(' + JSON_STRING_ + ')\\]\\)', 'g');
  let match;
  while ((match = pattern.exec(text))) parts.push(JSON.parse(match[1]));
  return parts.join('');
}

/**
 * The cards in the Available column, each with its id, title, raw video link and tags.
 *
 * The page data is a list of rows, "id:value", that together describe the page as nested
 * elements: ["$", type, key, props]. Parts of the page can sit in later rows and are pointed
 * to with "$L<id>", so every lookup follows those pointers.
 */
function readAvailable_(data) {
  const rows = {};
  data.split('\n').forEach(function (line) {
    const row = line.match(/^([0-9a-f]+):([[{"].*)$/);
    if (!row) return;
    try {
      rows[row[1]] = JSON.parse(row[2]);
    } catch (e) {
      // Not a value row, for example the start of a long text block.
    }
  });

  const column = findElements_(rows, Object.keys(rows).map(function (id) { return '$L' + id; }),
    function (props, key) { return key === 'available' && props.className === 'board-column'; })[0];
  if (!column) throw new Error('Couldn\'t find the Available column on the board. Has the hub changed?');

  const cards = findElements_(rows, column[3].children, function (props) {
    return props.className === 'video-card';
  }).map(function (card) {
    const title = findElements_(rows, card[3].children, function (props) {
      return props.className === 'video-card-title';
    })[0];
    const tags = findElements_(rows, card[3].children, function (props) {
      return props.className === 'video-card-tags';
    })[0];
    return {
      id: String(card[2]),
      title: (title ? textOf_(rows, title[3].children) : '').trim() || 'New video',
      link: title && typeof title[3].href === 'string' ? title[3].href : '',
      tags: tags ? [].concat(tags[3].children).map(function (tag) { return textOf_(rows, tag).trim(); })
        .filter(Boolean) : [],
    };
  });

  // A count above zero with no cards read means the board's layout has changed.
  const count = findElements_(rows, column[3].children, function (props) {
    return props.className === 'board-column-count';
  })[0];
  if (count && Number(count[3].children) > 0 && !cards.length) {
    throw new Error('Available shows ' + count[3].children + ' video(s), but none could be read. ' +
      'Has the hub changed?');
  }
  return cards;
}

/** Every element under `value` whose props match, without looking inside the matches. */
function findElements_(rows, value, matches, found, seen) {
  found = found || [];
  seen = seen || {};
  const row = pointer_(rows, value);
  if (row) {
    if (!seen[row]) {
      seen[row] = true;
      findElements_(rows, rows[row], matches, found, seen);
    }
  } else if (Array.isArray(value) && value[0] === '$' && value[3] && typeof value[3] === 'object') {
    if (matches(value[3], value[2])) found.push(value);
    else findElements_(rows, value[3].children, matches, found, seen);
  } else if (Array.isArray(value)) {
    value.forEach(function (item) { findElements_(rows, item, matches, found, seen); });
  } else if (value && typeof value === 'object') {
    Object.keys(value).forEach(function (key) { findElements_(rows, value[key], matches, found, seen); });
  }
  return found;
}

/** The text shown for a piece of page data, such as a card's title or one of its tags. */
function textOf_(rows, value, depth) {
  depth = depth || 0;
  if (depth > 50) return '';
  const row = pointer_(rows, value);
  if (row) return textOf_(rows, rows[row], depth + 1);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.indexOf('$$') === 0 ? value.slice(1) : value.charAt(0) === '$' ? '' : value;
  if (Array.isArray(value) && value[0] === '$') return value[3] ? textOf_(rows, value[3].children, depth + 1) : '';
  if (Array.isArray(value)) return value.map(function (item) { return textOf_(rows, item, depth + 1); }).join('');
  return '';
}

/** The row a "$L<id>" or "$<id>" pointer refers to, if it's in the page data. */
function pointer_(rows, value) {
  const match = typeof value === 'string' && value.match(/^\$L?([0-9a-f]+)$/);
  return match && rows[match[1]] !== undefined ? match[1] : null;
}

// ---------- Telegram ----------

function telegramRaw_(method, payload) {
  const token = String(CONFIG.TELEGRAM_BOT_TOKEN).trim();
  if (!token) throw new Error('Fill in TELEGRAM_BOT_TOKEN at the top of the script.');
  try {
    const response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true,
    });
    let body = {};
    try {
      body = JSON.parse(response.getContentText());
    } catch (e) {
      // Not JSON, e.g. a proxy error page. The status code below still says what happened.
    }
    return {
      ok: body.ok === true,
      code: body.ok ? 200 : (body.error_code || response.getResponseCode()),
      description: body.description || '',
      result: body.result,
    };
  } catch (e) {
    return { ok: false, code: 0, description: String(e.message || e) }; // network error, try again later
  }
}

function telegram_(method, payload) {
  const res = telegramRaw_(method, payload);
  if (res.ok) return res.result;
  if (res.code === 401 || res.code === 404) {
    throw new Error('Telegram rejected the bot token. Copy TELEGRAM_BOT_TOKEN again from @BotFather.');
  }
  throw new Error('Telegram ' + method + ' failed (' + res.code + '): ' + res.description);
}

/**
 * Adds everyone who opened the invite link (which sends the bot "/start <invite code>")
 * since the last check, and welcomes them. A plain Start, without the code, is turned away:
 * anyone on Telegram can find the bot, but only people with the link should get alerts.
 */
function acceptNewMembers_(saved) {
  const updates = telegram_('getUpdates', {
    offset: Number(saved.lastUpdateId || 0) + 1, // also tells Telegram the earlier ones are handled
    timeout: 0,
    allowed_updates: ['message'],
  });
  if (!updates.length) return;

  const store = PropertiesService.getScriptProperties();
  updates.forEach(function (update) {
    const message = update.message;
    const start = message && message.text && message.text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?/);
    if (!start) return;

    const chat = chatInfo_(message.chat);
    const known = loadChats_().some(function (c) { return c.id === chat.id; });
    if (!saved.inviteCode || start[1] !== saved.inviteCode) {
      if (!known) {
        telegramRaw_('sendMessage', { chat_id: chat.id,
          text: '🔒 This bot sends private alerts. Ask the person who runs it for the invite link.' });
      }
      return;
    }
    if (known) {
      telegramRaw_('sendMessage', { chat_id: chat.id, text: '✅ You already get Available alerts here.' });
      return;
    }

    // Tell the people already on the list, so nobody joins unnoticed.
    if (loadChats_().length) sendToChats_('👋 <b>' + escapeHtml_(chat.name) + '</b> joined the Available alerts.', []);
    saveChats_(loadChats_().concat([chat]));
    telegramRaw_('sendMessage', {
      chat_id: chat.id,
      parse_mode: 'HTML',
      text: '✅ <b>You\'re in</b>\nYou\'ll get a message here when a new video shows up in Available.',
    });
    console.log('%s joined the Available alerts.', chat.name);
  });
  store.setProperty('lastUpdateId', String(updates[updates.length - 1].update_id));
}

function chatInfo_(chat) {
  const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') ||
    (chat.username ? '@' + chat.username : String(chat.id));
  return { id: chat.id, name: name };
}

function inviteLink_(saved) {
  return 'https://t.me/' + saved.botUsername + '?start=' + saved.inviteCode;
}

function mergeChats_(saved, found) {
  const byId = {};
  saved.concat(found).forEach(function (chat) { byId[chat.id] = chat; });
  return Object.keys(byId).map(function (id) { return byId[id]; });
}

function loadChats_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('chats') || '[]');
}

function saveChats_(chats) {
  PropertiesService.getScriptProperties().setProperty('chats', JSON.stringify(chats));
}

// ---------- Helpers ----------

function checkInterval_() {
  if ([1, 5, 10, 15, 30].indexOf(CONFIG.CHECK_EVERY_MINUTES) === -1) {
    throw new Error('CHECK_EVERY_MINUTES must be 1, 5, 10, 15 or 30.');
  }
}

function escapeHtml_(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
