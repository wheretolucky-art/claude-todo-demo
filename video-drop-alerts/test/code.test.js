// Runs Code.gs against a fake hub, a fake Telegram and fake Apps Script services.
// Usage: node --test video-drop-alerts/test/code.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const BOT_TOKEN = '123456:TEST';
const HUB = 'https://hub.example.com';
const INVITE_CODE = '0123abcd456789ef'; // from the fake Utilities.getUuid below
const INVITE_LINK = 'https://t.me/video_drops_bot?start=' + INVITE_CODE;
const BOARD_BUTTON = { text: '📋 Open board', url: HUB + '/board' };

let nextCard = 1;
function card(title, extra = {}) {
  const id = 'card-' + String(nextCard++).padStart(4, '0') + '-0000-0000-000000000000';
  return { id, title, link: 'https://drive.google.com/file/d/raw' + id.slice(5, 9) + '/view?usp=drivesdk', ...extra };
}

/**
 * The board's page data in the hub's format: rows of "id:value", with the first card of each
 * column inline and the rest in later rows that the column points to with "$L<id>".
 */
function boardData(hub) {
  const later = [];
  let nextRow = 0x30;
  const text = (value) => (value.startsWith('$') ? '$' + value : value); // how the format escapes "$"
  const cardElement = (c, column) => ['$', 'div', c.id, {
    className: hub.cardClass || 'video-card',
    style: { '--accent': `var(--accent-${column})` },
    children: [
      c.link
        ? ['$', 'a', null, { href: c.link, target: '_blank', rel: 'noopener noreferrer', className: 'video-card-title', children: text(c.title) }]
        : ['$', 'span', null, { className: 'video-card-title', children: text(c.title) }],
      ['$', 'div', null, { className: 'video-card-tags', children: [
        ['$', 'span', null, { className: 'pill', children: c.type || 'UGC' }],
        c.priority ? ['$', 'span', null, { className: 'pill', style: { background: 'red' }, children: '★ Priority' }] : false,
        null,
        false,
      ] }],
      ['$', '$L22', null, { videoId: c.id, referenceUrl: null }],
      ['$', 'div', null, { className: 'video-card-actions', children: [['$', '$L2d', null, { videoId: c.id, label: 'Claim' }]] }],
    ],
  }];
  const column = (key, title, cards) => ['$', 'div', key, { className: 'board-column', children: [
    ['$', 'div', null, { className: 'board-column-head', children: [
      ['$', 'span', null, { className: 'board-column-title', children: title }],
      ['$', 'span', null, { className: 'board-column-count', children: cards.length }],
    ] }],
    ['$', 'div', null, { className: 'board-column-cards', children: cards.length
      ? [false, cards.map((c, i) => {
        if (i === 0) return cardElement(c, key);
        const row = (nextRow++).toString(16);
        later.push(row + ':' + JSON.stringify(cardElement(c, key)));
        return '$L' + row;
      })]
      : [['$', 'p', null, { className: 'empty-state', children: 'Nothing here.' }], []] }],
  ] }];
  const page = ['$', 'main', null, { className: 'shell', children: [
    ['$', 'h1', null, { children: 'Production Board' }],
    ['$', 'div', null, { className: 'board-grid', children: [
      column('available', 'Available', hub.available),
      column('editing', 'Editing', hub.editing),
      column('posted', 'Posted', hub.posted),
    ] }],
  ] }];
  return [
    '1:"$Sreact.fragment"',
    '22:I[39756,["/_next/static/chunks/a.js"],"default"]',
    '0:{"P":null,"b":"build","f":[[["",{"children":["board",{}]}],["$","$1","c",{"children":["$L4"]}]]]}',
    '4:' + JSON.stringify(page),
    ...later,
  ].join('\n') + '\n';
}

/** The same page data, the way a full HTML page carries it. */
function boardHtml(data) {
  const third = Math.ceil(data.length / 3);
  const parts = [data.slice(0, third), data.slice(third, 2 * third), data.slice(2 * third)];
  return '<!DOCTYPE html><html><body><div class="shell">Production Board</div>' +
    parts.map((part) => `<script>self.__next_f.push([1,${JSON.stringify(part)}])</script>`).join('') +
    '</body></html>';
}

function createWorld() {
  const hub = {
    name: 'Omar',
    code: 'c0de1234',
    actionId: 'aa11',
    sessions: new Set(),
    logins: 0,
    boardLoads: 0,
    available: [card('5/10 Acme 1')],
    editing: [card('4/10 Globex 2')],
    posted: [card('1/10 Initech 3')],
    down: false,
    changed: false,
    htmlOnly: false,
    cookieAsList: false,
  };
  const telegram = {
    updates: [{ update_id: 1, message: { chat: { id: 111, type: 'private', first_name: 'Sam' }, text: '/start' } }],
    sent: [],
    replies: [], // queued failures for the next sendMessage calls, e.g. { code: 429 }
  };
  const props = {};
  const triggers = [];
  const logs = [];
  let locked = false;
  let nextUpdateId = 2;

  function response(code, body, headers = {}) {
    return { getResponseCode: () => code, getContentText: () => body, getAllHeaders: () => headers };
  }

  function fetchHub(url, options) {
    const { pathname } = new URL(url);
    if (pathname === '/login' && (options.method || 'get') === 'get') {
      return response(200, `<form><input type="hidden" name="$ACTION_ID_${hub.actionId}"/><input name="name"/></form>`);
    }
    if (pathname === '/login') {
      assert.equal(options.followRedirects, false);
      const boundary = options.contentType.match(/^multipart\/form-data; boundary=(.+)$/)[1];
      assert.ok(options.payload.endsWith('--' + boundary + '--\r\n'));
      const fields = {};
      for (const [, name, value] of options.payload.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) fields[name] = value;
      hub.logins++;
      if (!('$ACTION_ID_' + hub.actionId in fields) || fields.name !== hub.name || fields.code !== hub.code) {
        return response(200, '<form>Wrong name or code</form>');
      }
      const session = 'sess-' + hub.logins;
      hub.sessions.add(session);
      const cookie = `chub_editor_id=${session}; Path=/; Expires=Sun, 03 Jan 2027 19:14:27 GMT; HttpOnly`;
      return response(303, '', { Location: '/board', 'Set-Cookie': hub.cookieAsList ? [cookie, 'theme=dark; Path=/'] : cookie });
    }
    if (pathname === '/board') {
      hub.boardLoads++;
      if (hub.down) return response(500, 'Internal Server Error');
      const session = ((options.headers && options.headers.Cookie) || '').match(/chub_editor_id=([^;]+)/);
      if (!session || !hub.sessions.has(session[1])) return response(307, '', { Location: '/login' });
      if (hub.changed) return response(200, '0:{"P":null,"f":[["$","main",null,{"children":"A new design"}]]}\n');
      const data = boardData(hub);
      return response(200, hub.htmlOnly || options.headers.RSC !== '1' ? boardHtml(data) : data);
    }
    throw new Error('Unexpected hub URL ' + url);
  }

  function fetchTelegram(url, options) {
    assert.ok(url.startsWith('https://api.telegram.org/bot' + BOT_TOKEN + '/'), url);
    const method = url.split('/').pop();
    const payload = JSON.parse(options.payload);
    const json = (code, body) => response(code, JSON.stringify(body));
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

  const scriptProperties = {
    getProperty: (key) => (key in props ? props[key] : null),
    setProperty(key, value) {
      this.setProperties({ [key]: value });
    },
    getProperties: () => ({ ...props }),
    setProperties(values) {
      for (const [key, value] of Object.entries(values)) {
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
      fetch: (url, options = {}) => (url.startsWith(HUB) ? fetchHub(url, options) : fetchTelegram(url, options)),
    },
    PropertiesService: { getScriptProperties: () => scriptProperties },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => (locked ? false : (locked = true)),
        releaseLock: () => { locked = false; },
      }),
    },
    ScriptApp: {
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
    Utilities: { getUuid: () => '0123abcd-4567-89ef-0123-456789abcdef' },
  });
  vm.runInContext(CODE, context);
  vm.runInContext(
    `CONFIG.TELEGRAM_BOT_TOKEN = '${BOT_TOKEN}';
     CONFIG.HUB_URL = 'hub.example.com/board/';
     CONFIG.HUB_NAME = 'Omar';
     CONFIG.HUB_ACCESS_CODE = 'c0de1234';`,
    context,
  );

  return {
    hub, telegram, props, triggers, logs,
    run: (code) => vm.runInContext(code, context),
    setLocked: (value) => { locked = value; },
    sendToBot: (chat, text) => telegram.updates.push({ update_id: nextUpdateId++, message: { chat, text } }),
  };
}

function setUp() {
  const world = createWorld();
  world.run('setup()');
  world.telegram.sent.length = 0; // drop the "alerts are on" message
  return world;
}

const titlesSent = (world) => world.telegram.sent.map((m) => m.text);

test('setup logs in, remembers what is already in Available, starts the timer and confirms', () => {
  const world = createWorld();
  world.run('setup()');

  assert.equal(world.hub.logins, 1);
  assert.equal(world.props.hubCookie, 'chub_editor_id=sess-1');
  assert.deepEqual(JSON.parse(world.props.available), [world.hub.available[0].id]);
  assert.equal(world.triggers.length, 1);
  assert.equal(world.triggers[0].getHandlerFunction(), 'checkForNewVideos');
  assert.equal(world.triggers[0].minutes, 1);

  assert.equal(world.telegram.sent.length, 1);
  const message = world.telegram.sent[0];
  assert.equal(message.chat_id, 111);
  assert.equal(message.text, '✅ <b>Available alerts are on</b>\nYou\'ll get a message here when a new video ' +
    'shows up in Available. 1 video is in Available right now.\n\nTo add someone, send them this link:\n' + INVITE_LINK);
  assert.deepEqual(message.reply_markup.inline_keyboard, [[BOARD_BUTTON]]);
  assert.deepEqual(world.logs, [
    'Logged in to the hub as %s. %s Omar 1 video is in Available right now.',
    'Alerts go to: Sam',
    'Invite link. Anyone who opens it and taps Start gets alerts: %s ' + INVITE_LINK,
  ]);
});

test('a video that lands in Available sends one alert with the raw video and the board', () => {
  const world = setUp();
  const fresh = card('6/10 Acme 2', { priority: true });
  world.hub.available.push(fresh);
  world.run('checkForNewVideos()');

  assert.equal(world.telegram.sent.length, 1);
  assert.equal(world.telegram.sent[0].text, '🆕 <b>New video in Available</b>\n<b>6/10 Acme 2</b>\nUGC · ★ Priority');
  assert.deepEqual(world.telegram.sent[0].reply_markup.inline_keyboard, [[
    { text: '▶️ Raw video', url: fresh.link },
    BOARD_BUTTON,
  ]]);

  // Still sitting there a minute later: no second alert.
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 1);
});

test('several new videos at once arrive as one message, linked, and long lists are cut short', () => {
  const world = setUp();
  world.hub.available.push(card('6/10 Acme 2'), card('6/10 Acme 3', { type: 'Personal brand' }));
  world.run('checkForNewVideos()');
  const [first, second] = world.hub.available.slice(1);
  assert.deepEqual(titlesSent(world), ['🆕 <b>2 new videos in Available</b>\n' +
    `• <a href="${first.link}">6/10 Acme 2</a> · UGC\n` +
    `• <a href="${second.link}">6/10 Acme 3</a> · Personal brand`]);
  assert.deepEqual(world.telegram.sent[0].reply_markup.inline_keyboard, [[BOARD_BUTTON]]);

  for (let i = 0; i < 25; i++) world.hub.available.push(card('7/10 Batch ' + i));
  world.run('checkForNewVideos()');
  const lines = world.telegram.sent[1].text.split('\n');
  assert.equal(lines[0], '🆕 <b>25 new videos in Available</b>');
  assert.equal(lines.length, 1 + 20 + 1);
  assert.equal(lines[lines.length - 1], '…and 5 more');
});

test('claiming stays quiet, and a video released back to Available alerts again', () => {
  const world = setUp();
  const video = world.hub.available.shift(); // claimed
  world.hub.editing.push(video);
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 0);

  world.hub.editing.pop(); // released
  world.hub.available.push(video);
  world.run('checkForNewVideos()');
  assert.deepEqual(titlesSent(world), ['🆕 <b>New video in Available</b>\n<b>5/10 Acme 1</b>\nUGC']);
});

test('videos in the other columns never alert', () => {
  const world = setUp();
  world.hub.editing.push(card('6/10 Globex 9'));
  world.hub.posted.push(card('6/10 Initech 9'));
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 0);
});

test('when the session runs out it logs in again, reading the form fresh', () => {
  const world = setUp();
  world.hub.sessions.clear();
  world.hub.actionId = 'bb22'; // the hub was updated since
  world.hub.available.push(card('6/10 Acme 2'));
  world.run('checkForNewVideos()');

  assert.equal(world.hub.logins, 2);
  assert.equal(world.props.hubCookie, 'chub_editor_id=sess-2');
  assert.equal(world.telegram.sent.length, 1);
});

test('extra cookies from the hub are kept with the session', () => {
  const world = createWorld();
  world.hub.cookieAsList = true;
  world.run('setup()');
  assert.equal(world.props.hubCookie, 'chub_editor_id=sess-1; theme=dark');
});

test('setup explains a wrong name or access code, and missing settings', () => {
  const wrong = createWorld();
  wrong.run("CONFIG.HUB_ACCESS_CODE = 'nope'");
  assert.throws(() => wrong.run('setup()'), /didn't accept HUB_NAME and HUB_ACCESS_CODE/);
  assert.equal(wrong.triggers.length, 0);

  const missing = createWorld();
  missing.run("CONFIG.HUB_NAME = ''");
  assert.throws(() => missing.run('setup()'), /Fill in HUB_NAME and HUB_ACCESS_CODE/);
});

test('a hub outage fails the check without losing anything', () => {
  const world = setUp();
  world.hub.available.push(card('6/10 Acme 2'));
  world.hub.down = true;
  const before = world.props.available;
  assert.throws(() => world.run('checkForNewVideos()'), /isn't answering right now \(500\)/);
  assert.equal(world.props.available, before);
  assert.equal(world.hub.logins, 1, 'no point logging in again for an outage');

  world.hub.down = false;
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 1);
});

test('a redesigned hub is reported instead of going quiet', () => {
  const world = setUp();
  world.hub.changed = true;
  assert.throws(() => world.run('checkForNewVideos()'), /Couldn't open the board, even after logging in again/);

  const renamed = setUp();
  renamed.hub.cardClass = 'video-tile';
  assert.throws(() => renamed.run('checkForNewVideos()'), /Available shows 1 video\(s\), but none could be read/);
});

test('the page data is read from a full HTML page too', () => {
  const world = setUp();
  world.hub.htmlOnly = true;
  world.hub.available.push(card('6/10 Acme 2'), card('6/10 Acme 3'));
  world.run('checkForNewVideos()');
  assert.match(world.telegram.sent[0].text, /^🆕 <b>2 new videos in Available<\/b>/);
});

test('titles are decoded and escaped safely', () => {
  const world = setUp();
  world.hub.available.push(card('6/10 "Acme" <Ad> & Co'), card('$5 Deal'));
  world.run('checkForNewVideos()');
  const text = world.telegram.sent[0].text;
  assert.match(text, />6\/10 &quot;Acme&quot; &lt;Ad&gt; &amp; Co<\/a>/);
  assert.match(text, />\$5 Deal<\/a>/);
});

test('a Telegram outage is retried on the next check, and not repeated after', () => {
  const world = setUp();
  world.hub.available.push(card('6/10 Acme 2'));
  world.telegram.replies.push({ code: 429, description: 'Too Many Requests: retry after 5' });
  assert.throws(() => world.run('checkForNewVideos()'), /1 Telegram message\(s\) failed/);
  assert.equal(world.telegram.sent.length, 0);

  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 1);
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 1);
});

test('someone who blocks the bot is removed', () => {
  const world = setUp();
  world.hub.available.push(card('6/10 Acme 2'));
  world.telegram.replies.push({ code: 403, description: 'Forbidden: bot was blocked by the user' });
  assert.throws(() => world.run('checkForNewVideos()'), /failed/);
  assert.deepEqual(JSON.parse(world.props.chats), []);
});

test('opening the invite link adds someone without running setup again', () => {
  const world = setUp();
  world.sendToBot({ id: 222, type: 'private', first_name: 'Priya' }, '/start ' + INVITE_CODE);
  world.hub.available.push(card('6/10 Acme 2'));
  world.run('checkForNewVideos()');

  assert.deepEqual(JSON.parse(world.props.chats), [{ id: 111, name: 'Sam' }, { id: 222, name: 'Priya' }]);
  assert.deepEqual(world.telegram.sent.map((m) => [m.chat_id, m.text.split('\n')[0]]), [
    [111, '👋 <b>Priya</b> joined the Available alerts.'],
    [222, '✅ <b>You\'re in</b>'],
    [111, '🆕 <b>New video in Available</b>'],
    [222, '🆕 <b>New video in Available</b>'],
  ]);
  assert.equal(world.props.lastUpdateId, '2');
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

test('running setup again keeps the invite link and does not let in a plain Start', () => {
  const world = setUp();
  world.sendToBot({ id: 333, type: 'private', first_name: 'Stranger' }, '/start');
  world.run('setup()');
  assert.equal(world.props.inviteCode, INVITE_CODE);
  assert.deepEqual(JSON.parse(world.props.chats), [{ id: 111, name: 'Sam' }]);
  assert.equal(world.triggers.length, 1);

  world.logs.length = 0;
  world.run('showInviteLink()');
  assert.deepEqual(world.logs, ['Invite link. Anyone who opens it and taps Start gets alerts: %s ' + INVITE_LINK]);
});

test('a group can join with the invite link', () => {
  const world = setUp();
  world.sendToBot({ id: -1001, type: 'supergroup', title: 'Editing team' }, '/start@video_drops_bot ' + INVITE_CODE);
  world.run('checkForNewVideos()');
  assert.deepEqual(JSON.parse(world.props.chats)[1], { id: -1001, name: 'Editing team' });
});

test('setup works before anyone has pressed Start', () => {
  const world = createWorld();
  world.telegram.updates = [];
  world.run('setup()');
  assert.equal(world.triggers.length, 1);
  assert.equal(world.telegram.sent.length, 0);
  assert.ok(world.logs.includes('Nobody gets alerts yet.'));

  world.sendToBot({ id: 222, type: 'private', first_name: 'Priya' }, '/start ' + INVITE_CODE);
  world.run('checkForNewVideos()');
  assert.deepEqual(world.telegram.sent.map((m) => m.chat_id), [222]); // just the welcome
  assert.ok(!world.logs.some((line) => /Nobody gets alerts\. /.test(line)));
});

test('a Telegram hiccup while looking for new people does not hold up alerts', () => {
  const world = setUp();
  world.telegram.failUpdates = true;
  world.hub.available.push(card('6/10 Acme 2'));
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 1);
  assert.ok(world.logs.some((line) => /Couldn't check the bot for new people/.test(line)));
});

test('a check that is already running is not run twice', () => {
  const world = setUp();
  world.hub.available.push(card('6/10 Acme 2'));
  world.setLocked(true);
  world.run('checkForNewVideos()');
  assert.equal(world.hub.boardLoads, 1, 'only the load during setup');
  world.setLocked(false);
  world.run('checkForNewVideos()');
  assert.equal(world.telegram.sent.length, 1);
});

test('stop removes the timer', () => {
  const world = setUp();
  world.run('stop()');
  assert.equal(world.triggers.length, 0);
});
