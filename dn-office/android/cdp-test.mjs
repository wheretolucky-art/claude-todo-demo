// Drives DN Office inside the emulator's Android WebView over the DevTools protocol:
// loads made-up sample records, opens the + menu, presses the Android back button,
// shares a CCTV card and a quote PDF (Android share sheet), and records screenshots.
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const OUT = process.argv[2];
const log = (...a) => fs.appendFileSync(`${OUT}/smoke.log`, a.join(' ') + '\n');
const sh = (c) => execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => { fs.writeFileSync(`${OUT}/${name}.png`, execSync('adb exec-out screencap -p', { maxBuffer: 64 * 1024 * 1024 })); log('screenshot', name); };
const back = async () => { sh('adb shell input keyevent KEYCODE_BACK'); await sleep(1500); };
const top = () => {
  try { const m = sh('adb shell dumpsys activity activities').match(/ResumedActivity[^\n]*/i); return m ? m[0].trim() : '?'; }
  catch { return '?'; }
};

// Made-up records for the test. Never real customers: this repository is public.
const sample = {
  clients: [{ id: 'c_sample', name: 'Sample Shop', phone: '90000 00001', type: 'Shop', area: 'Main Road, Hazaribagh', notes: '', createdAt: '2026-10-10T10:00:00Z' }],
  jobs: [{
    id: 'j_sample', clientId: 'c_sample', title: 'CCTV: 4 HD cameras with DVR', status: 'Done', amount: 18900, cost: 0,
    quoteNo: 'DN-0900', date: '2026-10-10', workDate: '2026-10-12', followUp: '', amcUntil: '', warrantyUntil: '', notes: '',
    payments: [{ id: 'p_sample', amount: 5000, date: '2026-10-10', mode: 'UPI', note: 'advance' }], createdAt: '2026-10-10T10:00:00Z',
    quote: { no: 'DN-0900', date: '2026-10-10', validDays: '7', discount: '', interstate: false, withGst: false, terms: 'Sample terms.',
      items: [{ desc: 'HD camera', qty: '4', unit: 'Nos', rate: '1800', gst: '18' }, { desc: 'DVR', qty: '1', unit: 'Nos', rate: '5400', gst: '18' },
        { desc: 'Surveillance hard disk 500 GB', qty: '1', unit: 'Nos', rate: '3500', gst: '18' }, { desc: 'Installation and configuration', qty: '4', unit: 'Nos', rate: '500', gst: '18' }] },
  }],
};

let sock = '';
for (let i = 0; i < 30 && !sock; i++) {
  const m = sh('adb shell cat /proc/net/unix').match(/@(webview_devtools_remote_\d+)/);
  if (m) sock = m[1]; else await sleep(1000);
}
if (!sock) { log('no WebView debug socket'); process.exit(0); }
sh(`adb forward tcp:9222 localabstract:${sock}`);
let target;
for (let i = 0; i < 20 && !target; i++) {
  try { const list = await (await fetch('http://127.0.0.1:9222/json')).json(); target = list.find((t) => (t.url || '').includes('appassets')); } catch {}
  if (!target) await sleep(1000);
}
if (!target) { log('no page to drive'); process.exit(0); }
log('driving', target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console: ' + m.params.args.map((a) => a.value).join(' '));
};
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
const click = async (selector, wait = 1200) => { const ok = await js(`(function(){ var e = document.querySelector(${JSON.stringify(selector)}); if (e) e.click(); return !!e; })()`); log('click', selector, ok ? 'ok' : 'NOT FOUND'); await sleep(wait); return ok; };
await send('Runtime.enable');

await js(`(function(){ localStorage.setItem('dn-office-phone-v1', JSON.stringify(Object.assign({ v:1, meta:{ lastBackup:'' } }, ${JSON.stringify(sample)}))); location.reload(); return true; })()`);
await sleep(6000);
await send('Runtime.enable');
log('native bridge present:', await js('!!window.DNAndroid'), '| jsPDF bundled:', await js('!!window.jspdf'));
log('today tiles:', await js(`(document.querySelector('.tiles') || {}).innerText`));
shot('screen-1-today');

await click('.fab', 1500);
log('sheet open after +:', await js(`document.getElementById('sheet').open`));
shot('screen-2-new-menu');
await back();
log('sheet open after back:', await js(`document.getElementById('sheet').open`), '| top:', top());
shot('screen-3-after-back');

await click('.navbtn[data-view="jobs"]', 800);
await click('.chip[data-jobs-tab="all"]', 800);
await click('[data-act="job"][data-id="j_sample"]', 1500);
shot('screen-4-job');
await click('#sheet [data-act="card"]', 6000);
log('after sharing the CCTV card, top:', top());
shot('screen-5-share-card');
await back();
log('back in app after share sheet:', top());

await click('#sheet [data-act="edit-quote"]', 1500);
await click('[data-act="q-pdf"]', 6000);
log('after sharing the quote PDF, top:', top());
shot('screen-6-share-pdf');
await back();

await back();
log('after back: title', await js(`document.getElementById('title').textContent`), '| sheet open', await js(`document.getElementById('sheet').open`));
await back();
log('after back again: title', await js(`document.getElementById('title').textContent`));
shot('screen-7-today-again');
log('page errors:', JSON.stringify(errors));
ws.close();
process.exit(0);
