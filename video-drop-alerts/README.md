# Available alerts

Sends a Telegram message within about a minute of a new video showing up in the hub's
**Available** column, so you can claim it straight away. It runs on Google's servers for
free, so nothing has to stay open, and it doesn't change the hub.

An alert looks like this:

```
🆕 New video in Available
6/10 Acme 2
UGC · ★ Priority
[ ▶️ Raw video ]  [ 📋 Open board ]
```

When several land at once, for example after an overnight sync, they arrive as one message
listing each video. A video counts as new when it wasn't in Available at the last check, so
one that an editor releases back to Available alerts again. Videos already in Available when
you set it up don't alert.

## 1. Make the Telegram bot (2 minutes, on a phone)

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Pick a name (for example "Video Drops") and a username that ends in `bot`.
3. BotFather replies with a **token** that looks like `123456789:AAH...`. Copy it and keep
   it private: anyone with it can send messages as the bot.
4. That's all for now. After setup you'll get an invite link to share.

## 2. Add the script (5 minutes, on a computer)

Any Google account works, including your own.

1. Go to [script.google.com](https://script.google.com), click **New project**, and name it
   "Available alerts".
2. Open `Code.gs` and replace everything in it with [Code.gs](Code.gs).
3. Fill in the top of `Code.gs`:
   - `TELEGRAM_BOT_TOKEN`: the token from BotFather.
   - `HUB_URL`: the hub's address.
   - `HUB_NAME` and `HUB_ACCESS_CODE`: the name and access code you log in to the hub with.
4. Save with Ctrl+S (⌘S on a Mac).
5. In the toolbar, choose **setup** from the function list and click **Run**. Google asks for
   permission: click **Review permissions**, pick the account, then **Advanced** →
   **Go to Available alerts (unsafe)** → **Allow**. The warning appears because this is your
   own script rather than a published app. It asks to connect to outside services (the hub
   and Telegram) and to run when you're not there (the timer).
6. The log ends with an **invite link** like `https://t.me/YourBot?start=...`. Open it
   yourself, and send it to anyone else who should get alerts. Each person taps **Start** and
   gets **✅ You're in** within a minute. Nobody has to run anything again. Anyone with the
   link can join, so only send it to people who should get alerts. If someone finds the bot
   without the link, the bot turns them away.

## 3. Test it

Run `sendTestAlert` to check that Telegram works. The real test is the next video that
lands in Available.

## Good to know

- **It checks once a minute**, logging in to the hub as you. If your access code changes,
  update `HUB_ACCESS_CODE` and run `setup` again.
- **Add someone later:** send them the invite link. They're added within a minute, and
  everyone already on the list gets a "👋 ... joined" message. Lost the link? Run
  `showInviteLink`.
- **Leave the alerts:** block the bot in Telegram. The script drops them from the list.
- **Pause alerts:** run `stop`. Run `setup` to switch them back on.
- **If something goes wrong,** for example the hub's layout changes or the access code stops
  working, Google emails the script's owner a summary of failed runs. The **Executions** page
  (left sidebar) shows the details. A failed alert is retried on the next check.
- **Run time:** free Google accounts get 90 minutes of timer run time a day, and a check takes
  a second or two, so checking every minute fits. If Google says the limit was reached, set
  `CHECK_EVERY_MINUTES` to 5 and run `setup` again.

## For whoever maintains this

- A check loads `/board` with the `RSC: 1` header, which returns only the page data (about
  430 KB instead of 800 KB). It logs in again only when the saved session has run out, and
  reads the login form each time, because its hidden action field changes whenever the hub
  is updated.
- The page data is React Server Components rows (`id:value`). Parts of the board sit in later
  rows that the board points to with `$L<id>`, so the reader follows those pointers to find
  the Available column and its cards, and compares card IDs with the previous check.
- When a Telegram send fails, the previous list is kept, so the same videos still count as
  new and the alert is retried on the next check.
- Telegram is used rather than ntfy.sh because ntfy's free server limits messages per IP
  address, and Apps Script shares its IP addresses with other people's scripts.
- Tests run `Code.gs` against a fake hub, Telegram and Apps Script services:
  `node --test video-drop-alerts/test/code.test.js`
