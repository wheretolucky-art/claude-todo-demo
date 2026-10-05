/**
 * Video drop alerts
 *
 * Sends a Telegram message within a minute of a new file landing anywhere inside one
 * Google Drive folder, including its subfolders (for example "Completed Videos" with its
 * month and week folders). Runs on Google's servers, so nothing has to stay open.
 *
 * Setup steps are in README.md next to this file. In short: fill in CONFIG, then run setup().
 */

// ======== Fill these in ========
const CONFIG = {
  // The token @BotFather gave you in Telegram. It looks like 123456789:AAH...
  TELEGRAM_BOT_TOKEN: '',

  // Link to the Drive folder to watch (the "Completed Videos" folder), or just its ID.
  COMPLETED_FOLDER: '',

  // Optional: the hub's web address. Adds an "Open hub" button to every alert.
  HUB_URL: '',

  // How often to check, in minutes: 1, 5, 10, 15 or 30.
  CHECK_EVERY_MINUTES: 1,
};
// ===============================

const DRIVE_API_ = 'https://www.googleapis.com/drive/v3';
const GOOGLE_NATIVE_TYPE_ = 'application/vnd.google-apps.'; // folders, Docs, Sheets, shortcuts
const SEEN_LIMIT_ = 8000; // file IDs remembered so a file never alerts twice
const CHUNK_CHARS_ = 2000; // stays under the 9 KB limit per stored value
const FOLDER_CACHE_SECONDS_ = 6 * 60 * 60;

/**
 * Run once after filling in CONFIG. Running it again is safe: use it to add people
 * who pressed Start on the bot later, or after changing COMPLETED_FOLDER.
 */
function setup() {
  checkInterval_();
  const rootId = folderId_();
  let root;
  try {
    root = DriveApp.getFolderById(rootId);
  } catch (e) {
    throw new Error('Can\'t open the COMPLETED_FOLDER folder. Check the link, and that this Google ' +
      'account can open the folder in Drive.');
  }

  const bot = telegram_('getMe');
  const chats = mergeChats_(loadChats_(), chatsFromUpdates_());
  if (!chats.length) {
    throw new Error('Nobody has started the bot yet. Open https://t.me/' + bot.username +
      ' in Telegram, press Start, then run setup again.');
  }

  // Start reading changes from now. Taken before the scan below, so an upload that lands
  // mid-scan is either in the scan or in the changes, never in neither.
  const pageToken = driveGet_('/changes/startPageToken', { supportsAllDrives: true }).startPageToken;

  // Files already in the folder never trigger an alert, even if someone renames them later.
  const store = PropertiesService.getScriptProperties();
  const seen = loadSeen_(store.getProperties());
  const existing = addFolderFiles_(root, seen);

  const state = seenToProperties_(seen);
  state.rootId = rootId;
  state.rootName = root.getName();
  state.chats = JSON.stringify(chats);
  state.pageToken = pageToken;
  store.setProperties(state);

  stop();
  ScriptApp.newTrigger('checkForNewVideos').timeBased().everyMinutes(CONFIG.CHECK_EVERY_MINUTES).create();

  const result = sendToChats_(
    '✅ <b>Video alerts are on</b>\nYou\'ll get a message here when a new video lands in <b>' +
    escapeHtml_(root.getName()) + '</b>.', hubButtons_());
  if (!result.sent) {
    throw new Error('Alerts are switched on, but the test message to Telegram failed. Check the ' +
      'execution log, then run sendTestAlert.');
  }
  console.log('Watching "%s" (%s files already there). Alerts go to: %s',
    root.getName(), existing, loadChats_().map(function (c) { return c.name; }).join(', '));
}

/** Runs on the timer that setup() creates. */
function checkForNewVideos() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return; // the previous check is still running

  try {
    const store = PropertiesService.getScriptProperties();
    const saved = store.getProperties();
    if (!saved.pageToken || !saved.rootId) throw new Error('Run setup first.');
    if (saved.rootId !== folderId_()) throw new Error('COMPLETED_FOLDER has changed. Run setup again.');

    // 1. Every file that changed anywhere in Drive since the last check.
    const changed = {};
    let pageToken = saved.pageToken;
    let nextToken = null;
    while (pageToken) {
      const page = driveGet_('/changes', {
        pageToken: pageToken,
        pageSize: 1000,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        includeRemoved: false,
        fields: 'nextPageToken,newStartPageToken,changes(file(id,name,mimeType,parents,trashed,' +
          'webViewLink,size,owners(displayName),lastModifyingUser(displayName)))',
      });
      (page.changes || []).forEach(function (change) {
        if (change.file) changed[change.file.id] = change.file;
      });
      pageToken = page.nextPageToken;
      if (page.newStartPageToken) nextToken = page.newStartPageToken;
    }

    // 2. Keep the uploaded files (not folders or Google Docs) that sit inside the watched folder.
    const folders = {};
    const arrivals = [];
    Object.keys(changed).forEach(function (id) {
      const file = changed[id];
      if (file.trashed || file.mimeType.indexOf(GOOGLE_NATIVE_TYPE_) === 0) return;
      const path = pathInside_(file.parents && file.parents[0], saved.rootId, folders);
      if (path) arrivals.push({ file: file, path: [saved.rootName].concat(path) });
    });

    // 3. Alert for the ones not seen before.
    let retry = false;
    let failures = 0;
    if (arrivals.length) {
      const seen = loadSeen_(saved);
      let sentBefore = false;
      let added = false;
      arrivals.forEach(function (arrival) {
        if (seen.has(arrival.file.id)) return;
        if (sentBefore) Utilities.sleep(1000); // Telegram allows about one message per second per chat
        sentBefore = true;
        const result = sendToChats_(alertText_(arrival.file, arrival.path), alertButtons_(arrival.file));
        if (result.delivered) {
          seen.add(arrival.file.id);
          added = true;
        } else {
          retry = true;
        }
        failures += result.failures;
      });
      if (added) store.setProperties(seenToProperties_(seen));
    }

    // If a send failed, keep the old page token so the same changes are read and retried next time.
    // Files that were already delivered are in the seen list, so they don't alert twice.
    if (!retry && nextToken) store.setProperty('pageToken', nextToken);
    if (failures) throw new Error(failures + ' Telegram message(s) failed. Details are in the log above.');
  } finally {
    lock.releaseLock();
  }
}

/** Sends a test message to everyone who gets alerts. */
function sendTestAlert() {
  const result = sendToChats_('🔔 <b>Test alert</b>\nVideo alerts can reach you here.', hubButtons_());
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

function alertText_(file, path) {
  const revision = /\(revision\)/i.test(file.name);
  const by = (file.lastModifyingUser && file.lastModifyingUser.displayName) ||
    (file.owners && file.owners[0] && file.owners[0].displayName) || '';
  const details = [by && '👤 ' + escapeHtml_(by), file.size && formatSize_(Number(file.size))]
    .filter(Boolean).join(' · ');

  return [
    revision ? '🔁 <b>Revision dropped</b>' : '🎬 <b>New video dropped</b>',
    '<b>' + escapeHtml_(file.name) + '</b>',
    details,
    '📁 ' + escapeHtml_(path.join(' › ')),
  ].filter(Boolean).join('\n');
}

function alertButtons_(file) {
  return [{
    text: '▶️ Watch video',
    url: file.webViewLink || 'https://drive.google.com/file/d/' + file.id + '/view',
  }].concat(hubButtons_());
}

function hubButtons_() {
  let url = String(CONFIG.HUB_URL).trim();
  if (!url) return [];
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url; // Telegram rejects buttons without it
  return [{ text: '📋 Open hub', url: url }];
}

/**
 * Sends one message to every saved chat. It counts as delivered when at least one chat got it,
 * or when nobody can be retried. People who blocked the bot are dropped from the list.
 */
function sendToChats_(text, buttons) {
  const chats = loadChats_();
  if (!chats.length) {
    console.error('Nobody gets alerts. Press Start on the bot in Telegram, then run setup again.');
    return { sent: 0, delivered: true, failures: 1 };
  }
  const keep = [];
  let sent = 0;
  let waiting = 0;
  let failures = 0;

  chats.forEach(function (chat) {
    const payload = { chat_id: chat.id, text: text, parse_mode: 'HTML' };
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
  if (!keep.length) console.error('Nobody gets alerts any more. Press Start on the bot, then run setup again.');
  return { sent: sent, delivered: sent > 0 || waiting === 0, failures: failures };
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

/** Chats that messaged the bot (pressed Start) in the last 24 hours. */
function chatsFromUpdates_() {
  return telegram_('getUpdates', {}).map(function (update) {
    const message = update.message || update.edited_message || update.channel_post ||
      update.my_chat_member;
    return message && message.chat;
  }).filter(Boolean).map(function (chat) {
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') ||
      (chat.username ? '@' + chat.username : String(chat.id));
    return { id: chat.id, name: name };
  });
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

// ---------- Drive ----------

function driveGet_(path, params) {
  const query = Object.keys(params || {}).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
  }).join('&');
  const response = UrlFetchApp.fetch(DRIVE_API_ + path + (query ? '?' + query : ''), {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  const code = response.getResponseCode();
  if (code === 200) return JSON.parse(response.getContentText());

  let error = {};
  try {
    error = JSON.parse(response.getContentText()).error || {};
  } catch (e) {
    // Not JSON; fall through with the status code only.
  }
  const reason = (error.errors && error.errors[0] && error.errors[0].reason) || error.status || '';
  if (reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(error.message || '')) {
    throw new Error('The Drive API is off for this script. Replace appsscript.json with the one from ' +
      'the setup guide, save, then run setup again.');
  }
  const failure = new Error('Drive request failed (' + code + ' ' + reason + '): ' + (error.message || ''));
  failure.code = code;
  failure.reason = reason;
  throw failure;
}

/**
 * Where folderId sits inside the watched folder, as a list of folder names
 * (['October', 'Week 1']; [] means the watched folder itself). Null when it's outside.
 */
function pathInside_(folderId, rootId, memo) {
  const names = [];
  let id = folderId;
  for (let depth = 0; id && depth < 20; depth++) {
    if (id === rootId) return names.reverse();
    const folder = folderInfo_(id, memo);
    if (!folder) return null;
    names.push(folder.name);
    id = folder.parent;
  }
  return null;
}

/** A folder's name and parent, or null when this account can't see it. Cached for 6 hours. */
function folderInfo_(id, memo) {
  if (id in memo) return memo[id];
  const cache = CacheService.getScriptCache();
  const cached = cache.get('folder:' + id);
  if (cached) return (memo[id] = JSON.parse(cached));

  let info = null;
  try {
    const folder = driveGet_('/files/' + encodeURIComponent(id), {
      fields: 'name,parents',
      supportsAllDrives: true,
    });
    info = { name: folder.name, parent: (folder.parents && folder.parents[0]) || null };
  } catch (e) {
    // Not found or no access means "outside the watched folder". Anything else (rate limits,
    // outages) is rethrown so the check fails and runs again next time with nothing skipped.
    const noAccess = e.code === 404 || (e.code === 403 &&
      /insufficientFilePermissions|forbidden|PERMISSION_DENIED/.test(e.reason));
    if (!noAccess) throw e;
  }
  cache.put('folder:' + id, JSON.stringify(info), FOLDER_CACHE_SECONDS_);
  return (memo[id] = info);
}

/** Adds every file in the folder and its subfolders to the seen list. Returns how many it found. */
function addFolderFiles_(folder, seen) {
  let count = 0;
  const files = folder.getFiles();
  for (; files.hasNext(); count++) seen.add(files.next().getId());
  const subfolders = folder.getFolders();
  while (subfolders.hasNext()) count += addFolderFiles_(subfolders.next(), seen);
  return count;
}

// ---------- Saved state ----------

/** The seen-file list, oldest first, stored across several properties to fit the size limit. */
function loadSeen_(saved) {
  const ids = [];
  const chunks = Number(saved.seenChunks || 0);
  for (let i = 0; i < chunks; i++) {
    if (saved['seen' + i]) ids.push.apply(ids, saved['seen' + i].split(','));
  }
  const lookup = {};
  ids.forEach(function (id) { lookup[id] = true; });
  return {
    ids: ids,
    has: function (id) { return lookup[id] === true; },
    add: function (id) {
      if (lookup[id]) return;
      lookup[id] = true;
      ids.push(id);
    },
  };
}

function seenToProperties_(seen) {
  const ids = seen.ids.slice(-SEEN_LIMIT_);
  const properties = {};
  let chunks = 0;
  for (let start = 0; start < ids.length; chunks++) {
    let end = start;
    let length = 0;
    while (end < ids.length && length + ids[end].length + 1 <= CHUNK_CHARS_) length += ids[end++].length + 1;
    properties['seen' + chunks] = ids.slice(start, end).join(',');
    start = end;
  }
  properties.seenChunks = String(chunks);
  return properties;
}

// ---------- Helpers ----------

function folderId_() {
  const value = String(CONFIG.COMPLETED_FOLDER).trim();
  if (!value) throw new Error('Paste the Completed Videos folder link into COMPLETED_FOLDER.');
  const match = value.match(/\/folders\/([\w-]+)/) || value.match(/[?&]id=([\w-]+)/);
  return match ? match[1] : value;
}

function checkInterval_() {
  if ([1, 5, 10, 15, 30].indexOf(CONFIG.CHECK_EVERY_MINUTES) === -1) {
    throw new Error('CHECK_EVERY_MINUTES must be 1, 5, 10, 15 or 30.');
  }
}

function formatSize_(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return Math.round(bytes / 1e6) + ' MB';
  return Math.max(1, Math.round(bytes / 1e3)) + ' KB';
}

function escapeHtml_(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
