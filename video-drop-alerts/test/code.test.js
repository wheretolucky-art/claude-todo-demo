// Runs Code.gs against a fake Google Drive and a fake Telegram.
// Usage: node --test video-drop-alerts/test/code.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const BOT_TOKEN = '123456:TEST';
const ROOT = 'completedRoot';
const INVITE_CODE = '0123abcd456789ef'; // from the fake Utilities.getUuid below
const INVITE_LINK = 'https://t.me/video_drops_bot?start=' + INVITE_CODE;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A small in-memory Drive with a changes feed, plus a Telegram bot and the Apps Script services. */
function createWorld({ pageSize = 1000 } = {}) {
  const drive = {
    items: {}, // id -> { id, name, mimeType, parent, trashed, size, by }
    changes: [], // file ids, in the order they changed
    failFolderLookups: 0, // next N folder lookups answer 500
    apiDisabled: false,
  };
  const telegram = {
    updates: [{ update_id: 1, message: { chat: { id: 111, type: 'private', first_name: 'Sam' }, text: '/start' } }],
    sent: [],
    replies: [], // queued failures for the next sendMessage calls, e.g. { code: 429 }
  };
  const props = {};
  const cache = {};
  const triggers = [];
  const logs = [];
  const sleeps = [];
  let locked = false;

  function addFolder(id, name, parent) {
    drive.items[id] = { id, name, mimeType: 'application/vnd.google-apps.folder', parent };
  }
  function addFile(id, name, parent, extra = {}) {
    drive.items[id] = { id, name, mimeType: 'video/mp4', parent, size: '248000000', by: 'Priya', ...extra };
    drive.changes.push(id);
  }
  function touch(id, update = {}) {
    Object.assign(drive.items[id], update);
    drive.changes.push(id);
  }
  let nextUpdateId = 2;
  function sendToBot(chat, text) {
    telegram.updates.push({ update_id: nextUpdateId++, message: { chat, text } });
  }

  addFolder('myDrive', 'My Drive', null);
  addFolder(ROOT, 'Completed Videos', 'myDrive');
  addFolder('oct', 'October', ROOT);
  addFolder('oct-w1', 'Week 1', 'oct');
  addFolder('sep', 'September', ROOT);
  addFolder('sep-w4', 'Week 4', 'sep');
  addFolder('raw', 'Raw Videos', 'myDrive');
  drive.items.old1 = { id: 'old1', name: '29/9 Globex 1 - Omar', mimeType: 'video/mp4', parent: 'sep-w4', by: 'Omar' };
  drive.items.old2 = { id: 'old2', name: '1/10 Initech 2-Lee.mp4', mimeType: 'video/mp4', parent: 'oct-w1', by: 'Lee' };
  drive.items.rawOld = { id: 'rawOld', name: 'raw clip.mov', mimeType: 'video/quicktime', parent: 'raw', by: 'Sam' };

  function json(code, body) {
    return { getResponseCode: () => code, getContentText: () => JSON.stringify(body) };
  }
  function driveResource(item) {
    return {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      parents: item.parent ? [item.parent] : undefined,
      trashed: !!item.trashed,
      webViewLink: 'https://drive.google.com/file/d/' + item.id + '/view?usp=drivesdk',
      size: item.size,
      owners: [{ displayName: item.by }],
      lastModifyingUser: { displayName: item.by },
    };
  }

  function fetchDrive(url) {
    if (drive.apiDisabled) {
      return json(403, { error: { code: 403, status: 'PERMISSION_DENIED',
        message: 'Google Drive API has not been used in project 1 before or it is disabled.',
        errors: [{ reason: 'accessNotConfigured' }] } });
    }
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/drive/v3/changes/startPageToken') {
      assert.equal(searchParams.get('supportsAllDrives'), 'true');
      return json(200, { startPageToken: String(drive.changes.length) });
    }
    if (pathname === '/drive/v3/changes') {
      assert.equal(searchParams.get('includeItemsFromAllDrives'), 'true');
      assert.match(searchParams.get('fields'), /newStartPageToken/);
      const from = Number(searchParams.get('pageToken'));
      const ids = drive.changes.slice(from, from + pageSize);
      const page = { changes: ids.map((id) => ({ fileId: id, file: driveResource(drive.items[id]) })) };
      if (from + pageSize < drive.changes.length) page.nextPageToken = String(from + pageSize);
      else page.newStartPageToken = String(drive.changes.length);
      return json(200, page);
    }
    const match = pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (match) {
      if (drive.failFolderLookups > 0) {
        drive.failFolderLookups--;
        return json(500, { error: { code: 500, message: 'Backend Error', errors: [{ reason: 'backendError' }] } });
      }
      const item = drive.items[decodeURIComponent(match[1])];
      if (!item || item.hidden) {
        return json(404, { error: { code: 404, message: 'File not found.', errors: [{ reason: 'notFound' }] } });
      }
      return json(200, { name: item.name, parents: item.parent ? [item.parent] : undefined });
    }
    throw new Error('Unexpected Drive URL ' + url);
  }

  function fetchTelegram(url, options) {
    assert.ok(url.startsWith('https://api.telegram.org/bot' + BOT_TOKEN + '/'), url);
    const method = url.split('/').pop();
    const payload = JSON.parse(options.payload);
    if (method === 'getMe') return json(200, { ok: true, result: { username: 'video_drops_bot' } });
    if (method === 'getUpdates') {
      if (telegram.failUpdates) throw new Error('Address unavailable');
      // Like Telegram: asking from an offset confirms, and forgets, everything before it.
      const offset = payload.offset || 0;
      telegram.updates = telegram.updates.filter((update) => update.update_id >= offset);
      return json(200, { ok: true, result: telegram.updates });
    }
    if (method === 'sendMessage') {
      const reply = telegram.replies.shift();
      if (reply && reply.network) throw new Error('Address unavailable');
      if (reply) return json(reply.code, { ok: false, error_code: reply.code, description: reply.description || 'Error' });
      telegram.sent.push(payload);
      return json(200, { ok: true, result: { message_id: telegram.sent.length } });
    }
    throw new Error('Unexpected Telegram method ' + method);
  }

  function iterator(list) {
    let i = 0;
    return { hasNext: () => i < list.length, next: () => list[i++] };
  }
  function folderHandle(id) {
    const item = drive.items[id];
    if (!item || item.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error('No item with the given ID could be found.');
    }
    const children = Object.values(drive.items).filter((child) => child.parent === id && !child.trashed);
    return {
      getName: () => item.name,
      getFiles: () => iterator(children.filter((c) => !c.mimeType.endsWith('.folder')).map((c) => ({ getId: () => c.id }))),
      getFolders: () => iterator(children.filter((c) => c.mimeType.endsWith('.folder')).map((c) => folderHandle(c.id))),
    };
  }

  const scriptProperties = {
    getProperty: (key) => (key in props ? props[key] : null),
    setProperty(key, value) {
      this.setProperties({ [key]: value });
    },
    getProperties: () => ({ ...props }),
    setProperties(values) {
      for (const [key, value] of Object.entries(values)) {
        // The real limit is 9 KB per value; fail loudly if the script ever goes over it.
        assert.ok(Buffer.byteLength(String(value)) <= 9 * 1024, 'property ' + key + ' is over 9 KB');
        props[key] = String(value);
      }
    },
  };

  const context = vm.createContext({
    console: {
      log: (...args) => logs.push(args.join(' ')),
      error: (...args) => logs.push('ERROR ' + args.join(' ')),
    },
    UrlFetchApp: {
      fetch(url, options = {}) {
        if (url.startsWith('https://www.googleapis.com/')) {
          assert.equal(options.headers.Authorization, 'Bearer oauth-token');
          return fetchDrive(url);
        }
        return fetchTelegram(url, options);
      },
    },
    PropertiesService: { getScriptProperties: () => scriptProperties },
    CacheService: {
      getScriptCache: () => ({
        get: (key) => (key in cache ? cache[key] : null),
        put: (key, value, seconds) => {
          assert.ok(seconds <= 21600);
          cache[key] = value;
        },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => (locked ? false : (locked = true)),
        releaseLock: () => { locked = false; },
      }),
    },
    ScriptApp: {
      getOAuthToken: () => 'oauth-token',
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (trigger) => triggers.splice(triggers.indexOf(trigger), 1),
      newTrigger: (handler) => ({
        timeBased: () => ({
          everyMinutes: (minutes) => ({
            create: () => triggers.push({ getHandlerFunction: () => handler, minutes }),
          }),
        }),
      }),
    },
    DriveApp: { getFolderById: folderHandle },
    Utilities: {
      sleep: (ms) => sleeps.push(ms),
      getUuid: () => '0123abcd-4567-89ef-0123-456789abcdef',
    },
  });
  vm.runInContext(CODE, context);
  vm.runInContext(
    `CONFIG.TELEGRAM_BOT_TOKEN = '${BOT_TOKEN}';
     CONFIG.COMPLETED_FOLDER = 'https://drive.google.com/drive/folders/${ROOT}?usp=sharing';
     CONFIG.HUB_URL = 'hub.example.com';`,
    context,
  );

  return {
    drive, telegram, props, cache, triggers, logs, sleeps, addFile, touch, addFolder, sendToBot,
    run: (code) => vm.runInContext(code, context),
    setLocked: (value) => { locked = value; },
  };
}

function setUp(options) {
  const world = createWorld(options);
  world.run('setup()');
  world.telegram.sent.length = 0; // drop the "alerts are on" message
  return world;
}

test('setup remembers existing files, starts the timer and sends a confirmation', () => {
  const world = createWorld();
  world.run('setup()');

  assert.equal(world.triggers.length, 1);
  assert.equal(world.triggers[0].getHandlerFunction(), 'checkForNewVideos');
  assert.equal(world.triggers[0].minutes, 1);

  assert.equal(world.telegram.sent.length, 1);
  assert.equal(world.telegram.sent[0].chat_id, 111);
  assert.match(world.telegram.sent[0].text, /Video alerts are on/);
  assert.match(world.telegram.sent[0].text, /<b>Completed Videos<\/b>/);
  assert.match(world.telegram.sent[0].text, new RegExp('send them this link:\\n' + escape(INVITE_LINK) + '$'));
  assert.equal(world.telegram.sent[0].reply_markup.inline_keyboard[0][0].url, 'https://hub.example.com');

  assert.equal(world.props.rootId, ROOT);
  assert.equal(world.props.pageToken, '0');
  const seen = world.props.seen0.split(',');
  assert.deepEqual(seen.sort(), ['old1', 'old2']); // not the raw footage outside the folder
  assert.deepEqual(JSON.parse(world.props.chats), [{ id: 111, name: 'Sam' }]);
  assert.equal(world.props.inviteCode, INVITE_CODE);
  assert.equal(world.props.lastUpdateId, '1');
  assert.deepEqual(world.logs, [
    'Watching "%s" (%s files already there). Completed Videos 2',
    'Alerts go to: Sam',
    'Invite link. Anyone who opens it and taps Start gets alerts: %s ' + INVITE_LINK,
  ]);
});

test('running setup again keeps the same invite link', () => {
  const world = setUp();
  world.run('setup()');
  assert.equal(world.props.inviteCode, INVITE_CODE);
  world.logs.length = 0;
  world.run('showInviteLink()');
  assert.deepEqual(world.logs, ['Invite link. Anyone who opens it and taps Start gets alerts: %s ' + INVITE_LINK]);
});

test('opening the invite link adds someone without running setup again', () => {
  const world = setUp();
  world.sendToBot({ id: 222, type: 'private', first_name: 'Priya' }, '/start ' + INVITE_CODE);
  world.run('checkForNewVideos()');

  assert.deepEqual(JSON.parse(world.props.chats), [{ id: 111, name: 'Sam' }, { id: 222, name: 'Priya' }]);
  assert.deepEqual(world.telegram.sent.map((m) => [m.chat_id, m.text.split('\n')[0]]), [
    [111, '👋 <b>Priya</b> joined the video alerts.'],
    [222, '✅ <b>You\'re in</b>'],
  ]);
  assert.match(world.telegram.sent[1].text, /lands in <b>Completed Videos<\/b>/);
  assert.equal(world.props.lastUpdateId, '2');

  // From now on both get the alerts, and the join isn't handled twice.
  world.telegram.sent.length = 0;
  world.addFile('a', 'first.mp4', 'oct-w1');
  world.run('checkForNewVideos()');
  assert.deepEqual(world.telegram.sent.map((m) => m.chat_id), [111, 222]);
});

test('someone who joins gets the alert for a video that lands in the same minute', () => {
  const world = setUp();
  world.sendToBot({ id: 222, type: 'private', first_name: 'Priya' }, '/start ' + INVITE_CODE);
  world.addFile('a', 'first.mp4', 'oct-w1');
  world.telegram.sent.length = 0;
  world.run('checkForNewVideos()');
  const alerts = world.telegram.sent.filter((m) => /New video dropped/.test(m.text));
  assert.deepEqual(alerts.map((m) => m.chat_id), [111, 222]);
});

test('a plain Start or a wrong code is turned away, once', () => {
  const world = setUp();
  world.sendToBot({ id: 333, type: 'private', first_name: 'Stranger' }, '/start');
  world.sendToBot({ id: 444, type: 'private', first_name: 'Guesser' }, '/start 1234');
  world.sendToBot({ id: 555, type: 'private', first_name: 'Chatty' }, 'hello?');
  world.run('checkForNewVideos()');

  assert.deepEqual(JSON.parse(world.props.chats), [{ id: 111, name: 'Sam' }]);
  assert.deepEqual(world.telegram.sent.map((m) => m.chat_id), [333, 444]);
  assert.match(world.telegram.sent[0].text, /Ask the person who runs it for the invite link/);

  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 2);
});

test('running setup again does not let in someone who pressed a plain Start', () => {
  const world = setUp();
  world.sendToBot({ id: 333, type: 'private', first_name: 'Stranger' }, '/start');
  world.run('setup()');
  assert.deepEqual(JSON.parse(world.props.chats), [{ id: 111, name: 'Sam' }]);

  world.telegram.sent.length = 0;
  world.run('checkForNewVideos()');
  assert.deepEqual(world.telegram.sent.map((m) => m.chat_id), [333]); // turned away
  assert.match(world.telegram.sent[0].text, /invite link/);
});

test('someone who pressed Start before setup is not turned away afterwards', () => {
  const world = setUp(); // Sam pressed a plain Start before setup
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 0);
});

test('opening the invite link twice does not add anyone twice', () => {
  const world = setUp();
  world.sendToBot({ id: 222, type: 'private', first_name: 'Priya' }, '/start ' + INVITE_CODE);
  world.sendToBot({ id: 222, type: 'private', first_name: 'Priya' }, '/start ' + INVITE_CODE);
  world.run('checkForNewVideos()');
  assert.equal(JSON.parse(world.props.chats).length, 2);
  assert.equal(world.telegram.sent[2].text, '✅ You already get video alerts here.');
});

test('a group can join with the invite link', () => {
  const world = setUp();
  world.sendToBot({ id: -1001, type: 'supergroup', title: 'Editing team' },
    '/start@video_drops_bot ' + INVITE_CODE);
  world.run('checkForNewVideos()');
  assert.deepEqual(JSON.parse(world.props.chats)[1], { id: -1001, name: 'Editing team' });
});

test('a setup from before invite links never lets a plain Start in', () => {
  const world = setUp();
  delete world.props.inviteCode;
  world.sendToBot({ id: 333, type: 'private', first_name: 'Stranger' }, '/start');
  world.sendToBot({ id: 444, type: 'private', first_name: 'Other' }, '/start undefined');
  world.run('checkForNewVideos()');
  assert.equal(JSON.parse(world.props.chats).length, 1);
});

test('a Telegram hiccup while looking for new people does not hold up video alerts', () => {
  const world = setUp();
  world.telegram.failUpdates = true;
  world.addFile('a', 'first.mp4', 'oct-w1');
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 1);
  assert.ok(world.logs.some((line) => /Couldn't check the bot for new people/.test(line)));
});

test('a change to a file that was already alerted does not rewrite the saved list', () => {
  const world = setUp();
  world.addFile('new1', 'first.mp4', 'oct-w1');
  world.run('checkForNewVideos()');
  const before = world.props.seen0;
  world.props.seen0 = 'sentinel,' + before; // would be overwritten by a needless save
  world.touch('new1', { name: 'first (renamed).mp4' });
  world.run('checkForNewVideos()');
  assert.equal(world.props.seen0, 'sentinel,' + before);
  assert.equal(world.telegram.sent.length, 1);
});

test('running setup twice keeps one timer', () => {
  const world = setUp();
  world.run('setup()');
  assert.equal(world.triggers.length, 1);
});

test('a new upload in a week folder sends one alert with a watch button', () => {
  const world = setUp();
  world.addFile('new1', '30/9 Acme 4 - Priya.mp4', 'oct-w1');
  world.run('checkForNewVideos()');

  assert.equal(world.telegram.sent.length, 1);
  const message = world.telegram.sent[0];
  assert.equal(message.parse_mode, 'HTML');
  assert.equal(message.text, [
    '🎬 <b>New video dropped</b>',
    '<b>30/9 Acme 4 - Priya.mp4</b>',
    '👤 Priya · 248 MB',
    '📁 Completed Videos › October › Week 1',
  ].join('\n'));
  assert.deepEqual(message.reply_markup.inline_keyboard, [[
    { text: '▶️ Watch video', url: 'https://drive.google.com/file/d/new1/view?usp=drivesdk' },
    { text: '📋 Open hub', url: 'https://hub.example.com' },
  ]]);
  assert.equal(world.props.pageToken, String(world.drive.changes.length));

  // The same file changing again (rename, re-sync) doesn't alert twice.
  world.touch('new1', { name: '30/9 Acme 4 - Priya (final).mp4' });
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 1);
});

test('files outside the folder, pre-existing files, folders, Docs and trashed files stay quiet', () => {
  const world = setUp();
  world.addFile('rawNew', 'new raw footage.mov', 'raw');
  world.touch('old1', { name: '29/9 Globex 1 - Omar renamed' });
  world.addFolder('oct-w2', 'Week 2', 'oct');
  world.drive.changes.push('oct-w2');
  world.addFile('doc', 'notes', 'oct-w1', { mimeType: 'application/vnd.google-apps.document' });
  world.addFile('gone', 'deleted.mp4', 'oct-w1', { trashed: true });
  world.run('checkForNewVideos()');

  assert.equal(world.telegram.sent.length, 0);
  assert.equal(world.props.pageToken, String(world.drive.changes.length));
});

test('revisions, files in the top folder and odd names are labelled and escaped', () => {
  const world = setUp();
  world.addFile('rev', '11/9 Umbrella 4 (revision) - kai', 'oct-w1', { size: '1500000000' });
  world.addFile('top', 'A<b> & "C".mp4', ROOT, { size: '5000' });
  world.run('checkForNewVideos()');

  assert.equal(world.telegram.sent.length, 2);
  const [revision, top] = world.telegram.sent;
  assert.match(revision.text, /^🔁 <b>Revision dropped<\/b>/);
  assert.match(revision.text, /1\.5 GB/);
  assert.match(top.text, /<b>A&lt;b&gt; &amp; "C"\.mp4<\/b>/);
  assert.match(top.text, /📁 Completed Videos$/);
  assert.deepEqual(world.sleeps, [1000]); // paced between the two messages
});

test('a new week folder created later is followed', () => {
  const world = setUp();
  world.addFolder('nov', 'November', ROOT);
  world.addFolder('nov-w1', 'Week 1', 'nov');
  world.addFile('nov1', '3/11 Globex 1 - Mia.mp4', 'nov-w1');
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 1);
  assert.match(world.telegram.sent[0].text, /Completed Videos › November › Week 1/);
});

test('a file moved into the folder alerts once it arrives', () => {
  const world = setUp();
  world.addFile('moved', '2/10 Hooli 1 - Noor.mp4', 'raw');
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 0);

  world.touch('moved', { parent: 'oct-w1' });
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 1);
});

test('a Telegram outage is retried on the next check without repeating delivered alerts', () => {
  const world = setUp();
  world.addFile('a', 'first.mp4', 'oct-w1');
  world.addFile('b', 'second.mp4', 'oct-w1');
  const tokenBefore = world.props.pageToken;
  // "first.mp4" goes through, "second.mp4" hits a rate limit.
  world.telegram.replies.push(undefined, { code: 429, description: 'Too Many Requests: retry after 5' });

  assert.throws(() => world.run('checkForNewVideos()'), /1 Telegram message\(s\) failed/);
  assert.deepEqual(world.telegram.sent.map((m) => m.text.split('\n')[1]), ['<b>first.mp4</b>']);
  assert.equal(world.props.pageToken, tokenBefore, 'page token kept so the failed alert is retried');

  world.run('checkForNewVideos()');
  assert.deepEqual(world.telegram.sent.map((m) => m.text.split('\n')[1]), ['<b>first.mp4</b>', '<b>second.mp4</b>']);
  assert.equal(world.props.pageToken, String(world.drive.changes.length));

  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 2);
});

test('a network error counts as an outage too', () => {
  const world = setUp();
  world.addFile('a', 'first.mp4', 'oct-w1');
  world.telegram.replies.push({ network: true });
  assert.throws(() => world.run('checkForNewVideos()'), /failed/);
  assert.equal(world.telegram.sent.length, 0);
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 1);
});

test('someone who blocks the bot is removed, and an empty list is reported', () => {
  const world = setUp();
  world.addFile('a', 'first.mp4', 'oct-w1');
  world.telegram.replies.push({ code: 403, description: 'Forbidden: bot was blocked by the user' });
  assert.throws(() => world.run('checkForNewVideos()'), /failed/);
  assert.deepEqual(JSON.parse(world.props.chats), []);
  assert.equal(world.props.pageToken, String(world.drive.changes.length), 'nothing left to retry');

  world.addFile('b', 'second.mp4', 'oct-w1');
  assert.throws(() => world.run('checkForNewVideos()'), /failed/);
  assert.ok(world.logs.some((line) => /Nobody gets alerts/.test(line)));
});

test('a Drive hiccup fails the check without skipping anything', () => {
  const world = setUp();
  world.run('checkForNewVideos()'); // nothing new; nothing cached yet either
  world.addFile('a', 'first.mp4', 'oct-w1');
  world.drive.failFolderLookups = 1;
  const tokenBefore = world.props.pageToken;

  assert.throws(() => world.run('checkForNewVideos()'), /Drive request failed \(500/);
  assert.equal(world.telegram.sent.length, 0);
  assert.equal(world.props.pageToken, tokenBefore);

  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 1);
});

test('folders this account cannot see count as outside, and are cached', () => {
  const world = setUp();
  world.addFolder('hidden', 'Someone else', null);
  world.drive.items.hidden.hidden = true;
  world.addFile('x', 'shared with me.mp4', 'hidden');
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 0);
  assert.equal(world.cache['folder:hidden'], 'null');
});

test('many changes across several pages are all read', () => {
  const world = setUp({ pageSize: 2 });
  for (let i = 1; i <= 5; i++) world.addFile('n' + i, 'video ' + i + '.mp4', 'oct-w1');
  world.addFile('r', 'raw.mov', 'raw');
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 5);
  assert.equal(world.props.pageToken, String(world.drive.changes.length));
});

test('thousands of existing files fit in storage and are all remembered', () => {
  const world = createWorld();
  const id = (i) => 'f' + String(i).padStart(4, '0') + 'x'.repeat(28); // Drive IDs are 33 characters
  for (let i = 0; i < 3000; i++) {
    world.drive.items[id(i)] = { id: id(i), name: 'v' + i, mimeType: 'video/mp4', parent: 'oct-w1' };
  }
  world.run('setup()');
  const chunks = Number(world.props.seenChunks);
  assert.ok(chunks > 1);
  const remembered = new Set();
  for (let i = 0; i < chunks; i++) world.props['seen' + i].split(',').forEach((id) => remembered.add(id));
  assert.equal(remembered.size, 3002);

  world.touch(id(42), { name: 'renamed' }); // an old file changing must not alert
  world.telegram.sent.length = 0;
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 0);
});

test('a check that is already running is not run twice', () => {
  const world = setUp();
  world.addFile('a', 'first.mp4', 'oct-w1');
  world.setLocked(true);
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 0);
  world.setLocked(false);
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 1);
});

test('setup works before anyone has pressed Start, and the invite link brings people in', () => {
  const world = createWorld();
  world.telegram.updates = [];
  world.run('setup()');
  assert.equal(world.triggers.length, 1);
  assert.equal(world.telegram.sent.length, 0);
  assert.ok(world.logs.includes('Nobody gets alerts yet.'));
  assert.equal(world.props.lastUpdateId, undefined);

  world.sendToBot({ id: 222, type: 'private', first_name: 'Priya' }, '/start ' + INVITE_CODE);
  world.run('checkForNewVideos()');
  assert.deepEqual(JSON.parse(world.props.chats), [{ id: 222, name: 'Priya' }]);
  assert.deepEqual(world.telegram.sent.map((m) => m.chat_id), [222]); // only the welcome
  assert.ok(!world.logs.some((line) => /Nobody gets alerts\. /.test(line)), 'no false alarm for the first person');
});

test('setup explains a wrong folder link and a disabled Drive API', () => {
  const wrongFolder = createWorld();
  wrongFolder.run("CONFIG.COMPLETED_FOLDER = 'https://drive.google.com/drive/folders/nope'");
  assert.throws(() => wrongFolder.run('setup()'), /Can't open the COMPLETED_FOLDER folder/);

  const apiOff = createWorld();
  apiOff.drive.apiDisabled = true;
  assert.throws(() => apiOff.run('setup()'), /Drive API is off/);
});

test('changing the folder after setup asks for setup again', () => {
  const world = setUp();
  world.run("CONFIG.COMPLETED_FOLDER = 'somewhereElse'");
  assert.throws(() => world.run('checkForNewVideos()'), /Run setup again/);
});

test('without a hub address, alerts only have the watch button', () => {
  const world = setUp();
  world.run("CONFIG.HUB_URL = ''");
  world.addFile('a', 'first.mp4', 'oct-w1');
  world.run('checkForNewVideos()');
  assert.deepEqual(world.telegram.sent[0].reply_markup.inline_keyboard[0].map((b) => b.text), ['▶️ Watch video']);
});

test('stop removes the timer', () => {
  const world = setUp();
  world.run('stop()');
  assert.equal(world.triggers.length, 0);
});
