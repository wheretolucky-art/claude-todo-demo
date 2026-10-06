# Video drop alerts

Sends a Telegram message within about a minute of an editor uploading a video into the
**Completed Videos** folder in Google Drive, including all its month and week folders.
It runs on Google's servers for free, so nothing has to stay open, and the hub itself
doesn't change.

An alert looks like this:

```
🎬 New video dropped
30/9 Acme 4 - Priya.mp4
👤 Priya · 248 MB
📁 Completed Videos › October › Week 1
[ ▶️ Watch video ]  [ 📋 Open hub ]
```

Files with "(revision)" in the name say **🔁 Revision dropped** instead. Each file alerts
once. Files that were already in the folder before setup never alert, even if someone
renames them later.

## 1. Make the Telegram bot (2 minutes, on a phone)

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Pick a name (for example "Video Drops") and a username that ends in `bot`.
3. BotFather replies with a **token** that looks like `123456789:AAH...`. Copy it and keep
   it private: anyone with it can send messages as the bot.
4. That's all for now. After setup you'll get an invite link to send to your client.

## 2. Add the script (5 minutes, on a computer)

Use your own Google account. It doesn't have to be your client's, but it must be able to
open the Completed Videos folder. If it can't, ask your client to share the folder with your
Gmail: in Google Drive, right-click **Completed Videos** → **Share**, add your Gmail as a
**Viewer**, and send. Viewer is enough, because the script only reads the folder.

1. Go to [script.google.com](https://script.google.com), click **New project**, and name it
   "Video drop alerts".
2. Click ⚙️ **Project Settings** and tick **Show "appsscript.json" manifest file in editor**.
3. Go back to the editor (`< >`), open `appsscript.json`, and replace everything in it with
   [appsscript.json](appsscript.json). This switches on the Drive API and limits the script
   to read-only access to Drive.
4. Open `Code.gs` and replace everything in it with [Code.gs](Code.gs).
5. Fill in the top of `Code.gs`:
   - `TELEGRAM_BOT_TOKEN`: the token from BotFather.
   - `COMPLETED_FOLDER`: the Completed Videos folder's link. Open the folder in Drive and
     copy the address bar.
   - `HUB_URL` (optional): the hub's address, for an "Open hub" button on each alert.
6. Save with Ctrl+S (⌘S on a Mac).
7. In the toolbar, choose **setup** from the function list and click **Run**. Google asks for
   permission: click **Review permissions**, pick the account, then **Advanced** →
   **Go to Video drop alerts (unsafe)** → **Allow**. The warning appears because this is
   your own script rather than a published app.
8. The log ends with an **invite link** like `https://t.me/YourBot?start=...`. Send it to your
   client. They open it, tap **Start**, and get **✅ You're in** within a minute. Nobody has to
   run anything again. Anyone with the link can join, so only send it to people who should get
   alerts. If someone finds the bot without the link, the bot turns them away.

## 3. Test it

When the next video lands in Completed Videos, Telegram should show the alert within about a
minute of the upload finishing. To test straight away instead, upload any short video into a
week folder and delete it afterwards. That needs **Editor** access to the folder.

## Alerts on a computer

Install [Telegram Desktop](https://desktop.telegram.org), or open
[web.telegram.org](https://web.telegram.org) in Chrome and allow notifications.

## Good to know

- **Slow uploads:** the alert comes when an upload finishes, not when it starts. A video that
  syncs overnight alerts when it lands in Drive.
- **Add someone later:** send them the invite link. They're added within a minute, and
  everyone already on the list gets a "👋 ... joined" message. Lost the link? Run
  `showInviteLink`.
- **Leave the alerts:** block the bot in Telegram. The script drops them from the list.
- **Pause alerts:** run `stop`. Run `setup` to switch them back on.
- **Check that Telegram works:** run `sendTestAlert`.
- **If something goes wrong,** Google emails the script's owner a summary of failed runs.
  The **Executions** page (left sidebar) shows the details. A failed alert is retried on the
  next check, so nothing is lost.
- **Run time:** free Google accounts get 90 minutes of timer run time a day. A check takes
  about a second, so checking every minute stays well under that. To check less often, set
  `CHECK_EVERY_MINUTES` to 5 and run `setup` again.

## For whoever maintains this

- Every check reads Drive's changes feed (one request when nothing happened), keeps uploaded
  files whose folder chain leads to the watched folder, and remembers alerted file IDs in
  Script Properties. When a Telegram send fails, the changes position isn't moved forward,
  so the next check retries. Alerts that already went out are remembered and not repeated.
- Telegram is used rather than ntfy.sh because ntfy's free server limits messages per IP
  address, and Apps Script shares its IP addresses with other people's scripts.
- Tests run `Code.gs` against fake Drive, Telegram and Apps Script services:
  `node --test video-drop-alerts/test/code.test.js`
