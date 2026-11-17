"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const AGENT_LOOK = {
  Scout: { c: "#3ef2e0", face: "◎" },
  Editor: { c: "#ff3d8b", face: "✂" },
  Captioner: { c: "#ffd25a", face: "Aa" },
  Producer: { c: "#ff8a3d", face: "★" },
  Publisher: { c: "#48f08a", face: "➤" },
};

const state = { lastLog: 0, clips: [], filter: "new", sort: "score", settings: {}, open: null, scoutsSeen: "" };

// ------------------------------------------------------------ api

async function api(path, body, opts = {}) {
  const init = body === undefined ? {} : {
    method: "POST",
    headers: { "X-Autoclip": "1", ...(body instanceof Blob ? {} : { "Content-Type": "application/json" }) },
    body: body instanceof Blob ? body : JSON.stringify(body),
  };
  const res = await fetch(path, { ...init, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}

function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("X-Autoclip", "1");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    xhr.onload = () => xhr.status === 200 ? resolve(JSON.parse(xhr.responseText).upload)
      : reject(new Error(JSON.parse(xhr.responseText || "{}").error || "upload failed"));
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.send(file);
  });
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), bad ? 6000 : 3000);
}

// ------------------------------------------------------------ routing

function route() {
  const page = (location.hash || "#agents").slice(1).split("/")[0];
  const known = ["agents", "generate", "clips", "settings"];
  const p = known.includes(page) ? page : "agents";
  known.forEach((k) => { $(`#page-${k}`).hidden = k !== p; });
  $$(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.page === p));
  if (p === "clips") loadClips();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------ settings chips (the PDF's "check the settings")

const CHIP_DEFAULTS = { ratio: "9:16", captions: true, hook: true, autoedit: false, layout: "blur", color: "yellow" };
const chipSets = {};

function makeChips(el) {
  const s = { ...CHIP_DEFAULTS };
  chipSets[el.dataset.settings] = s;
  const draw = () => {
    el.innerHTML = `
      <button type="button" class="chip" data-k="ratio">Ratio · <b>${s.ratio}</b></button>
      <button type="button" class="chip ${s.hook ? "" : "off"}" data-k="hook">Hook · <b>${s.hook ? "Auto" : "Off"}</b></button>
      <button type="button" class="chip ${s.captions ? "" : "off"}" data-k="captions">Subs · <b>${s.captions ? "word-level" : "Off"}</b></button>
      <button type="button" class="chip ${s.autoedit ? "" : "off"}" data-k="autoedit">Auto Edit · <b>${s.autoedit ? "On" : "Off"}</b></button>
      <button type="button" class="chip" data-k="layout">Layout · <b>${{ blur: "Full + blur", crop: "Crop", facecam: "Cam on top" }[s.layout]}</b></button>
      <button type="button" class="chip" data-k="color">Highlight · <b>${s.color}</b></button>
      ${s.layout === "facecam" ? `<input class="facecam" placeholder="webcam x,y,w,h e.g. 0.75,0.7,0.25,0.3" value="${esc(s.facecam || "")}" aria-label="Webcam area">` : ""}`;
    const fc = $(".facecam", el);
    if (fc) fc.addEventListener("input", () => { s.facecam = fc.value; });
  };
  const cycle = { ratio: ["9:16", "1:1", "16:9"], layout: ["blur", "crop", "facecam"], color: ["yellow", "green", "pink", "cyan"] };
  el.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    const k = b.dataset.k;
    if (cycle[k]) s[k] = cycle[k][(cycle[k].indexOf(s[k]) + 1) % cycle[k].length];
    else s[k] = !s[k];
    draw();
  });
  draw();
}
$$(".chips[data-settings]").forEach(makeChips);

// ------------------------------------------------------------ agents page

function drawTeam(agents) {
  $("#team").innerHTML = agents.map((a) => {
    const look = AGENT_LOOK[a.name];
    return `<div class="agent ${a.busy ? "busy" : ""}" style="--c:${look.c}">
      <span class="done" title="tasks done">${a.done}</span>
      <div class="face" style="background:${look.c}">${look.face}</div>
      <h4><span class="dot"></span>${a.name}</h4>
      <p>${esc(a.role)}</p>
      <div class="task">${a.busy ? esc(a.task) : '<span class="muted">idle</span>'}</div>
    </div>`;
  }).join("");
}

function fmtTime(t) { return new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }); }
function fmtDur(s) { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(x).padStart(2, "0")}`; }

function addFeed(entries) {
  const feed = $("#feed");
  for (const e of entries) {
    const li = document.createElement("li");
    const look = AGENT_LOOK[e.agent] || { c: "#fff" };
    li.style.setProperty("--c", look.c);
    li.innerHTML = `<time>${fmtTime(e.t)}</time><span class="who">${esc(e.agent)}</span>
      <span class="${e.level === "error" ? "err" : ""}">${esc(e.text)}${e.clip ? ` <a data-clip="${esc(e.clip)}">open</a>` : ""}</span>`;
    feed.prepend(li);
  }
  while (feed.children.length > 300) feed.lastChild.remove();
}
$("#feed").addEventListener("click", (e) => {
  const a = e.target.closest("a[data-clip]");
  if (!a) return;
  const c = state.clips.find((x) => x.id.endsWith(a.dataset.clip));
  if (c) openEditor(c.id); else { location.hash = "#clips"; }
});

function drawScouts(scouts) {
  const key = JSON.stringify(scouts);
  if (key === state.scoutsSeen) return;
  state.scoutsSeen = key;
  const el = $("#scouts");
  if (!scouts.length) {
    el.innerHTML = '<p class="empty">No Scouts yet. Add a channel above. A Scout waits for the stream to go live, records it, and clips every spike.</p>';
    return;
  }
  el.innerHTML = scouts.map((s) => {
    const live = s.state === "recording" && s.recording_since;
    const label = { recording: "Live", waiting: "Offline · waiting", stopped: "Stopped", error: "Error", starting: "Starting" }[s.state] || s.state;
    return `<div class="scout">
      <span class="badge ${s.state}">${label}</span>
      <div>
        <div class="name">${esc(s.channel)}</div>
        <div class="stats">${live ? `rec <span data-since="${s.recording_since}">${fmtDur(Date.now() / 1000 - s.recording_since)}</span> · ` : ""}${s.spikes} spikes · ${s.clips} clips${s.pending ? ` · ${s.pending} cutting` : ""} · ${s.signals.join("+")}</div>
        ${s.error ? `<div class="stats err">${esc(s.error)}</div>` : ""}
      </div>
      ${s.alive ? `<button class="btn small" data-stop="${s.id}">Stop</button>` : `<button class="btn small ghost" data-remove="${s.id}">Remove</button>`}
    </div>`;
  }).join("");
}
setInterval(() => $$("[data-since]").forEach((el) => { el.textContent = fmtDur(Date.now() / 1000 - +el.dataset.since); }), 1000);

$("#scouts").addEventListener("click", async (e) => {
  const stop = e.target.closest("[data-stop]"), rm = e.target.closest("[data-remove]");
  try {
    if (stop) { stop.disabled = true; await api(`/api/scouts/${stop.dataset.stop}/stop`, {}); toast("Scout is stopping. Clips already found will still be finished."); }
    if (rm) { await api(`/api/scouts/${rm.dataset.remove}/remove`, {}); state.scoutsSeen = ""; }
  } catch (err) { toast(err.message, true); }
});

function chipPayload(name) {
  const s = chipSets[name];
  return { ratio: s.ratio, captions: s.captions, hook: s.hook, autoedit: s.autoedit, layout: s.layout, color: s.color, facecam: s.facecam || "" };
}

function permNote(channel) {
  const ch = channel.trim().toLowerCase().replace(/^.*twitch\.tv\//, "").split(/[/?]/)[0];
  if (!ch) return null;
  const p = (state.settings.permissions || {})[ch];
  if (p && p.allowed) return { ok: true, text: `✓ ${ch} allowed clipping: “${p.note || "noted"}”` };
  if (p) return { ok: false, text: `${ch} has not allowed clipping (saved in Settings). Clips will be made, but think twice before posting.` };
  return { ok: false, text: `No permission saved for ${ch} yet. Ask them first, then save their reply in Settings. You can still collect clips.` };
}

$("#scoutForm [name=channel]").addEventListener("input", (e) => {
  const n = permNote(e.target.value), w = $("#scoutPerm");
  w.hidden = !n;
  if (n) { w.textContent = n.text; w.classList.toggle("ok", n.ok); }
});

$("#scoutForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = { ...Object.fromEntries(f), ...chipPayload("scout") };
  try {
    await api("/api/scouts", body);
    toast(`Scout assigned to ${body.channel}`);
    e.target.reset(); $("#scoutPerm").hidden = true;
  } catch (err) { toast(err.message, true); }
});

// ------------------------------------------------------------ generator page

let uploadName = null;
const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) pickVideo(f); });
$("#videoFile").addEventListener("change", (e) => e.target.files[0] && pickVideo(e.target.files[0]));
function pickVideo(f) { uploadName = f; $("#videoName").textContent = `${f.name} · ${(f.size / 1e6).toFixed(0)} MB`; $("#genForm [name=url]").value = ""; }
$("#maxClips").addEventListener("input", (e) => { $("#maxOut").textContent = e.target.value; });

$("#genForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("button[type=submit]", e.target);
  const f = new FormData(e.target);
  const body = { url: f.get("url").trim(), channel: f.get("channel"), max_clips: +f.get("max_clips"), ...chipPayload("gen") };
  if (!body.url && !uploadName) return toast("Paste a link or drop a video file first", true);
  btn.disabled = true;
  try {
    if (!body.url && uploadName) {
      const prog = $("#upProg"); prog.hidden = false;
      body.upload = await upload(uploadName, (p) => { prog.value = p; });
      body.upload_name = uploadName.name;
      prog.hidden = true;
    }
    const chat = $("#chatFile").files[0];
    if (chat) body.chat_upload = await upload(chat);
    await api("/api/generate", body);
    toast("On it. Watch the Scout and Editor on the Agents page.");
    e.target.reset(); uploadName = null; $("#videoName").textContent = ""; $("#maxOut").textContent = "10";
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
});

function drawJobs(jobs) {
  const el = $("#jobs");
  if (!jobs.length) { el.innerHTML = '<p class="empty">Nothing running.</p>'; return; }
  el.innerHTML = jobs.map((j) => `<div class="job ${j.status}">
    <div class="src">${esc(j.source)}</div>
    <div class="bar"><i style="width:${Math.round(j.progress * 100)}%"></i></div>
    <div class="muted small">${esc(j.step)}${j.status === "done" ? ` · <a href="#clips">see clips</a>` : ""}${j.error ? ` · <span class="err">${esc(j.error)}</span>` : ""}</div>
  </div>`).join("");
}

// ------------------------------------------------------------ clips page

const FILTERS = [["new", "To review"], ["kept", "Kept"], ["approved", "Ready to post"], ["posted", "Posted"], ["discarded", "Thrown out"], ["all", "All"]];

function drawFilters() {
  const counts = {};
  state.clips.forEach((c) => { counts[c.status] = (counts[c.status] || 0) + 1; });
  $("#filters").innerHTML = FILTERS.map(([k, label]) =>
    `<button role="tab" data-f="${k}" class="${state.filter === k ? "on" : ""}">${label} ${k === "all" ? state.clips.length : counts[k] || 0}</button>`).join("");
  $("#clipCount").textContent = counts.new || "";
}
$("#filters").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.filter = b.dataset.f; drawClips(); } });
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; drawClips(); });

function scoreClass(s) { return s >= 75 ? "hi" : s < 50 ? "lo" : ""; }

function drawClips() {
  drawFilters();
  let list = state.clips.filter((c) => state.filter === "all" || c.status === state.filter);
  list.sort(state.sort === "score" ? (a, b) => b.score - a.score : (a, b) => b.created - a.created);
  const el = $("#clips");
  if (!list.length) {
    el.innerHTML = `<p class="empty">${state.clips.length ? "Nothing here." : "No clips yet. Send a Scout to a live stream or use the Clip Generator."}</p>`;
    return;
  }
  // Keep existing cards (and their loaded videos) when nothing about them changed.
  const html = list.map((c) => {
    const key = `${c.id}|${c.version}|${c.status}|${c.rendering}|${c.score}|${c.hook}`;
    const old = el.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (old) return old.outerHTML;
    return `<button class="card" data-id="${esc(c.id)}" data-key="${esc(key)}">
      <div class="thumb">
        ${c.video ? `<video src="${c.video}#t=1" preload="metadata" muted playsinline></video>` : `<div class="rendering"><span class="spinner"></span>Editor is working…</div>`}
        <span class="score ${scoreClass(c.score)}">${c.score}</span>
        <span class="status-pill ${c.rendering ? "rendering" : c.status}">${c.rendering ? "rendering" : c.status === "new" ? "" : c.status}</span>
      </div>
      <div class="body">
        <div class="hook">${esc(c.hook || c.title || "Untitled")}</div>
        <div class="meta">${esc(c.channel)} · ${fmtDur(c.start_seconds)} · ${c.duration ? Math.round(c.duration) + "s" : ""} · ${esc(c.source)} ${c.spike_ratio}x</div>
      </div>
    </button>`;
  }).join("");
  el.innerHTML = html;
  $$(".status-pill", el).forEach((p) => { if (!p.textContent.trim()) p.remove(); });
}
$("#clips").addEventListener("click", (e) => { const c = e.target.closest(".card"); if (c) openEditor(c.dataset.id); });
$("#clips").addEventListener("mouseover", (e) => { const v = e.target.closest(".card")?.querySelector("video"); if (v) v.play().catch(() => {}); });
$("#clips").addEventListener("mouseout", (e) => { const v = e.target.closest(".card")?.querySelector("video"); if (v) v.pause(); });

async function loadClips() {
  try { state.clips = await api("/api/clips"); } catch { return; }
  if (!$("#page-clips").hidden) drawClips(); else drawFilters();
  if (state.open) fillEditor();
}

// ------------------------------------------------------------ clip editor

const ed = $("#editor");
const clipById = (id) => state.clips.find((c) => c.id === id);

function openEditor(id) {
  state.open = id;
  state.edVersion = null;
  fillEditor();
  if (!ed.open) ed.showModal();
}
$("#edClose").addEventListener("click", () => ed.close());
ed.addEventListener("close", () => { state.open = null; $("#edVideo").pause(); });
ed.addEventListener("click", (e) => { if (e.target === ed) ed.close(); });

function seg(el, options, value, onPick) {
  el.innerHTML = options.map(([v, label]) => `<button type="button" data-v="${v}" class="${v === value ? "on" : ""}">${label}</button>`).join("");
  el.onclick = (e) => { const b = e.target.closest("button"); if (b && b.dataset.v !== value) onPick(b.dataset.v); };
}

function fillEditor() {
  const c = clipById(state.open);
  if (!c) return;
  const o = c.options || {};
  const v = $("#edVideo");
  if (c.video && state.edVersion !== c.version) {
    state.edVersion = c.version;
    v.src = c.video;
  }
  $("#edRendering").hidden = !c.rendering;
  $("#edDownload").href = c.video ? c.video.replace(/\?.*/, "") + "?download=1" : "#";
  $("#edRaw").href = c.raw;
  const sc = $("#edScore"); sc.textContent = c.score; sc.className = `score big ${scoreClass(c.score)}`;
  $("#edTitle").textContent = c.title || c.hook || "Untitled clip";
  $("#edMeta").textContent = `${c.channel} · at ${fmtDur(c.start_seconds)} · ${c.source} spike ${c.spike_ratio}x normal · written by ${c.written_by === "claude" ? "Claude" : "rules"}`;
  $("#edReason").textContent = c.error ? `Render failed: ${c.error}` : c.reason || "";
  const st = $("#edStatus"); st.textContent = c.status; st.className = `status-pill ${c.status}`;
  $$(".tool").forEach((t) => {
    const k = t.dataset.tool;
    t.classList.toggle("on", k === "voice" ? !!o.voiceover : !!o[k]);
  });
  seg($("#edRatio"), [["9:16", "9:16"], ["1:1", "1:1"], ["16:9", "16:9"]], o.ratio || "9:16", (val) => setOpt({ ratio: val }));
  seg($("#edColor"), [["yellow", "Yellow"], ["green", "Green"], ["pink", "Pink"], ["cyan", "Cyan"]], o.color || "yellow", (val) => setOpt({ color: val }));
  seg($("#edLayout"), [["blur", "Full + blur"], ["crop", "Crop"], ["facecam", "Cam on top"]], o.layout || "blur", (val) => {
    if (val === "facecam" && !o.facecam) { $("#edFacecamWrap").hidden = false; $("#edFacecam").focus(); toast("Enter where the webcam is, then press Enter"); return; }
    setOpt({ layout: val });
  });
  $("#edFacecamWrap").hidden = o.layout !== "facecam" && $("#edFacecamWrap").hidden;
  if (o.facecam && document.activeElement !== $("#edFacecam")) $("#edFacecam").value = o.facecam.join(",");
  const tf = $("#textForm");
  if (!tf.contains(document.activeElement)) {
    tf.hook.value = c.hook || ""; tf.title.value = c.title || ""; tf.caption.value = c.caption || "";
    tf.hashtags.value = (c.hashtags || []).join(" ");
  }
  const pw = $("#edPerm");
  pw.hidden = false;
  pw.classList.toggle("ok", c.permission);
  pw.textContent = c.permission ? `✓ ${c.channel} allows clipping (saved in Settings).` : `No permission saved for ${c.channel}. Ask the streamer first and save their reply in Settings.`;
  $("#approve").textContent = c.status === "approved" ? "Approved ✓ (post text saved)" : "Approve for posting";
  $("#edTranscript").textContent = c.transcript || "No speech found.";
  $("#edLog").innerHTML = (c.log || []).slice().reverse().map((l) =>
    `<li><time>${new Date(l.t * 1000).toLocaleString()}</time>${esc(l.text)}</li>`).join("");
}

async function act(body, msg) {
  const c = clipById(state.open);
  try {
    await api(`/api/clips/${encodeURIComponent(c.id)}/action`, body);
    if (msg) toast(msg);
    await loadClips();
    return true;
  } catch (err) { toast(err.message, true); return false; }
}
const setOpt = (opts) => act({ action: "options", ...opts }, "Editor is re-rendering…");

$$(".decide [data-status]").forEach((b) => b.addEventListener("click", () => act({ action: "status", status: b.dataset.status })));
$$(".tool").forEach((t) => t.addEventListener("click", () => {
  const c = clipById(state.open), k = t.dataset.tool;
  if (k === "voice") return openRecorder();
  if (k === "captions" && !c.transcript && !c.options.captions) toast("No speech was found in this clip, so there are no captions to show", true);
  setOpt({ [k]: !c.options[k] });
}));
$("#edFacecam").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const parts = e.target.value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((x) => isNaN(x) || x < 0 || x > 1)) return toast("Use four fractions: x,y,width,height (e.g. 0.75,0.7,0.25,0.3)", true);
  setOpt({ layout: "facecam", facecam: parts });
});
$("#textForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  act({ action: "text", hook: f.hook.value, title: f.title.value, caption: f.caption.value, hashtags: f.hashtags.value.split(/[\s,]+/) }, "Saved");
  f.querySelector("button").blur();
});
$("#regen").addEventListener("click", async (e) => {
  e.target.disabled = true; e.target.textContent = "Producer is thinking…";
  await act({ action: "regenerate" }, "Producer rewrote the hook, title and caption");
  e.target.disabled = false; e.target.textContent = "Rewrite with Producer";
});
$("#approve").addEventListener("click", async () => {
  const c = clipById(state.open);
  try {
    await api(`/api/clips/${encodeURIComponent(c.id)}/action`, { action: "approve" });
    toast("Approved. The post text is saved next to the video.");
  } catch (err) {
    if (err.status === 409 && confirm(`${err.message}\n\nApprove anyway?`)) await act({ action: "approve", override: true }, "Approved without recorded permission");
    else if (err.status !== 409) toast(err.message, true);
  }
  loadClips();
});
$("#copyPost").addEventListener("click", async () => {
  const c = clipById(state.open);
  try { await navigator.clipboard.writeText(c.post_text); toast("Post text copied"); } catch { toast("Could not copy. Select the text in the form instead.", true); }
});
$("#postedForm").addEventListener("submit", (e) => {
  e.preventDefault();
  act({ action: "posted", url: e.target.url.value.trim() }, "Logged as posted");
  e.target.reset();
});

// ------------------------------------------------------------ voiceover recorder

const rec = $("#recorder");
let mediaRec = null, chunks = [], recStream = null;
function openRecorder() {
  const c = clipById(state.open);
  $("#recRemove").hidden = !c.has_voice;
  $("#recState").textContent = c.has_voice ? "A voiceover is on this clip. Record again to replace it." : "Ready";
  $("#recState").className = "rec-state";
  rec.showModal();
}
$("#recCancel").addEventListener("click", () => rec.close());
rec.addEventListener("close", stopRecording);
$("#recRemove").addEventListener("click", async () => { rec.close(); await setOpt({ voiceover: false }); });
$("#recStart").addEventListener("click", async () => {
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch { return toast("Microphone not available. Allow mic access for localhost in your browser.", true); }
  chunks = [];
  mediaRec = new MediaRecorder(recStream);
  mediaRec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mediaRec.onstop = sendRecording;
  const v = $("#edVideo");
  v.currentTime = 0;
  v.onended = () => stopRecording();
  mediaRec.start();
  await v.play().catch(() => {});
  $("#recStart").disabled = true; $("#recStop").disabled = false;
  const s = $("#recState"); s.className = "rec-state live";
  const t0 = Date.now();
  state.recTimer = setInterval(() => { s.textContent = `● Recording ${fmtDur((Date.now() - t0) / 1000)}`; }, 250);
});
$("#recStop").addEventListener("click", stopRecording);
function stopRecording() {
  clearInterval(state.recTimer);
  $("#edVideo").onended = null;
  if (mediaRec && mediaRec.state === "recording") { mediaRec.stop(); $("#edVideo").pause(); }
  if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
  $("#recStart").disabled = false; $("#recStop").disabled = true;
}
async function sendRecording() {
  const c = clipById(state.open);
  if (!chunks.length || !c) return;
  $("#recState").textContent = "Uploading…";
  try {
    await api(`/api/clips/${encodeURIComponent(c.id)}/voiceover`, new Blob(chunks, { type: mediaRec.mimeType }));
    rec.close();
    toast("Voiceover added. Editor is mixing it in.");
    loadClips();
  } catch (err) { toast(err.message, true); $("#recState").textContent = "Upload failed"; }
}

// ------------------------------------------------------------ settings page

function drawSettings(s) {
  state.settings = s;
  const pill = $("#aiPill");
  pill.textContent = s.claude ? "Producer: Claude" : "Producer: rules";
  pill.classList.toggle("claude", s.claude);
  $("#aiStatus").innerHTML = s.claude
    ? `Claude (<code>${esc(s.model)}</code>) is scoring clips and writing hooks${s.has_key ? ` with the key ending ${esc(s.key_hint)}` : " using ANTHROPIC_API_KEY from your environment"}.`
    : "No Claude key: the Producer uses simple rules (spike size and chat). Add a key for smarter scores and hooks.";
  $("#outDir").textContent = s.out_dir;
  const wf = $("#whisperForm [name=whisper_model]");
  if (document.activeElement !== wf) wf.value = s.whisper_model;
  const perms = Object.entries(s.permissions || {});
  $("#perms").innerHTML = perms.length ? perms.map(([ch, p]) => `<li>
      <span class="ch">${esc(ch)} <span class="${p.allowed ? "yes" : "no"}">${p.allowed ? "allowed" : "not allowed"}</span></span>
      <button class="link" data-unperm="${esc(ch)}">remove</button>
      ${p.note ? `<span class="note">“${esc(p.note)}” · ${new Date(p.at * 1000).toLocaleDateString()}</span>` : ""}
    </li>`).join("") : '<li class="muted">No streamers saved yet.</li>';
}
async function saveSettings(body, msg) {
  try { drawSettings(await api("/api/settings", body)); if (msg) toast(msg); } catch (err) { toast(err.message, true); }
}
$("#keyForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const k = e.target.anthropic_key.value.trim();
  if (!k) return toast("Paste a key first", true);
  saveSettings({ anthropic_key: k }, "Key saved on this computer"); e.target.reset();
});
$("#clearKey").addEventListener("click", () => saveSettings({ anthropic_key: "" }, "Key removed"));
$("#whisperForm [name=whisper_model]").addEventListener("change", (e) => saveSettings({ whisper_model: e.target.value }, "Saved. Used for new clips."));
$("#permForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  saveSettings({ permission: { channel: f.channel.value, allowed: f.allowed.value === "1", note: f.note.value } }, "Saved");
  f.reset();
});
$("#perms").addEventListener("click", (e) => {
  const b = e.target.closest("[data-unperm]");
  if (b) saveSettings({ permission: { channel: b.dataset.unperm, remove: true } });
});

// ------------------------------------------------------------ polling

async function poll() {
  try {
    const s = await api(`/api/state?after=${state.lastLog}`);
    drawTeam(s.agents);
    drawScouts(s.scouts);
    drawJobs(s.jobs);
    if (JSON.stringify(s.settings) !== JSON.stringify(state.settings)) drawSettings(s.settings);
    if (s.log.length) {
      addFeed(s.log);
      state.lastLog = s.log[s.log.length - 1].id;
      if (s.log.some((l) => ["Producer", "Editor", "Publisher"].includes(l.agent))) loadClips();
    }
  } catch { /* server restarting */ }
  setTimeout(poll, 1500);
}

route();
poll();
loadClips();
setInterval(() => { if (state.clips.some((c) => c.rendering) || !$("#page-clips").hidden) loadClips(); }, 4000);
