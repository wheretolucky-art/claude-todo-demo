// Turns the unsealed content into the six chapters of the book.

import { doodle, tulip } from "./doodles.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (text) => String(text).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

/** Escapes text, then turns *marked* words into emphasis. */
export const fmt = (text) => esc(text).replace(/\*([^*]+)\*/g, "<em>$1</em>");

// The running head is narrow on a phone, so the two long titles get a short form there.
const SHORT = { "04": "Letters", "05": "For You" };

const chapterHead = ({ no, title, lede, src }) => `
  <header class="ch-head">
    <p class="eyebrow" data-reveal>Chapter ${no}</p>
    <h2 class="ch-title" id="ch${no}-title" data-reveal style="--d:90ms">${esc(title)}</h2>
    <div class="ch-rule" data-reveal style="--d:180ms"></div>
    ${lede ? `<p class="ch-lede" data-reveal style="--d:260ms">${fmt(lede)}</p>` : ""}
    ${src ? `<p class="ch-src" data-reveal style="--d:340ms">${fmt(src)}</p>` : ""}
  </header>`;

const section = (no, name, tone, cls, body) => `
  <section class="sheet ${cls}" id="ch${no}" data-chapter data-no="${no}" data-name="${esc(SHORT[no] || name)}" data-tone="${tone}" aria-labelledby="ch${no}-title">
    ${body}
  </section>`;

/* ---------- 01 · The Beginning ---------- */

function beginning({ beginning: b }) {
  return section("01", "The Beginning", "light", "sheet--ivory ded", `
    <div class="ded__inner">
      <p class="eyebrow" data-reveal>Chapter 01 <span aria-hidden="true">·</span> The Beginning</p>
      <div data-reveal style="--d:150ms">${tulip("ded__tulip")}</div>
      <p class="ded__for" data-reveal style="--d:300ms">${esc(b.dedication)}</p>
      <h2 class="ded__line" id="ch01-title" data-reveal style="--d:450ms">${esc(b.line)}</h2>
    </div>
    <p class="ded__cue" aria-hidden="true"><span>Scroll</span><i></i></p>`);
}

/* ---------- 02 · Her ---------- */

const polaroid = (p, i) => `
  <figure class="polaroid" data-reveal style="--w:${p.w}; --r:${p.r}; --mt:${p.mt}; --d:${(i % 2) * 140}ms">
    <span class="polaroid__photo" style="--ar:${p.aspect}; --pos:${p.pos}">
      <img data-photo="${esc(p.id)}" alt="${esc(p.alt)}" decoding="async">
    </span>
    <figcaption>${esc(p.cap)}</figcaption>
    <button class="polaroid__open" type="button" data-open="${i}" aria-label="Look closer: ${esc(p.alt)}"></button>
  </figure>`;

function her({ her: h }) {
  return section("02", "Her", "light", "sheet--ivory", `
    ${chapterHead({ no: "02", title: "Her", lede: h.lede, src: h.src })}
    <div class="scatter" id="gallery">
      ${h.photos.map(polaroid).join("")}
    </div>
    <p class="aside" data-reveal>tap a photograph to hold it closer</p>`);
}

/* ---------- 03 · The Memories ---------- */

function chat(lines, to) {
  let last = null;
  return `<div class="chat">${lines.map((line) => {
    const who = line.who === "her" ? "her" : "me";
    const name = line.label || (who === "her" ? to : "me");
    const label = (line.label || last !== who) ? `<span class="chat__who chat__who--${who}">${esc(name)}</span>` : "";
    last = who;
    return `${label}<p class="chat__b chat__b--${who}">${esc(line.text)}</p>`;
  }).join("")}</div>`;
}

function memoBody(block, to) {
  if (block.t === "chat") return chat(block.lines, to);
  if (block.t === "em") return `<p class="memo__em">${fmt(block.text)}</p>`;
  return `<p>${fmt(block.text)}</p>`;
}

function memo(card, i, total, to) {
  const tilt = [-0.7, 0.5, -0.3, 0.8, -0.5][i % 5];
  const label = `aria-roledescription="slide" aria-label="${i + 1} of ${total}"`;
  if (card.photo) {
    return `
    <article class="memo memo--photo" ${label} style="--tilt:${card.r}">
      <figure class="snap" style="--ar:${card.aspect}">
        <span class="snap__tape" aria-hidden="true"></span>
        <img data-photo="${esc(card.photo)}" alt="${esc(card.alt)}" decoding="async">
        <button class="snap__open" type="button" data-open-photo="${esc(card.photo)}" aria-label="Look closer: ${esc(card.alt)}"></button>
      </figure>
    </article>`;
  }
  return `
    <article class="memo" ${label} style="--tilt:${tilt}">
      <span class="memo__tape" aria-hidden="true"></span>
      <header class="memo__head">
        <span class="stamp">${esc(card.stamp)}</span>
        <span class="memo__doodle">${doodle(card.doodle)}</span>
      </header>
      <h3 class="memo__title">${esc(card.title)}</h3>
      <div class="memo__body">${card.body.map((b) => memoBody(b, to)).join("")}</div>
    </article>`;
}

const arrow = (dir) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${dir === "prev" ? "M14.5 5l-7 7 7 7" : "M9.5 5l7 7-7 7"}"/></svg>`;

function memories({ memories: m, meta }) {
  const total = m.cards.length;
  return section("03", "The Memories", "light", "sheet--white", `
    ${chapterHead({ no: "03", title: "The Memories", lede: m.lede, src: m.src })}
    <div class="deck" id="deck">
      <div class="deck__track" tabindex="0" role="group" aria-roledescription="carousel" aria-label="Memories, in order">
        ${m.cards.map((card, i) => memo(card, i, total, meta.to)).join("")}
      </div>
      <div class="deck__ctrl">
        <button class="round" type="button" data-deck="prev" aria-label="Previous memory">${arrow("prev")}</button>
        <p class="deck__count" aria-live="polite"><span data-deck="now">01</span> <i aria-hidden="true">/</i> <span>${String(total).padStart(2, "0")}</span></p>
        <button class="round" type="button" data-deck="next" aria-label="Next memory">${arrow("next")}</button>
      </div>
    </div>`);
}

/* ---------- 04 · Letters I Never Wanted to Lose ---------- */

function letters({ letters: l }) {
  return section("04", "Letters I Never Wanted to Lose", "dark", "sheet--night", `
    ${chapterHead({ no: "04", title: "Letters I Never Wanted to Lose", lede: l.epigraph, src: l.epigraphSrc })}
    <p class="book__intro" data-reveal>${fmt(l.intro)}</p>
    <div class="book" id="book" data-reveal>
      <div class="book__stage" tabindex="0" role="group" aria-roledescription="book" aria-label="Pages from the book. Use the arrow keys, tap, or swipe to turn the page."></div>
      <div class="book__ctrl">
        <button class="round" type="button" data-book="prev" aria-label="Previous page">${arrow("prev")}</button>
        <p class="book__count" aria-live="polite"></p>
        <button class="round" type="button" data-book="next" aria-label="Next page">${arrow("next")}</button>
      </div>
      <p class="book__hint aside">tap the page, or swipe, to turn it</p>
    </div>`);
}

/* ---------- 05 · A Little Something for You ---------- */

function note({ note: n }) {
  return section("05", "A Little Something for You", "light", "sheet--ivory sheet--blush", `
    ${chapterHead({ no: "05", title: "A Little Something for You" })}
    <div class="env" id="env" data-reveal>
      <button class="env__btn" type="button" aria-expanded="false" aria-controls="note">
        <span class="env__back"></span>
        <span class="env__paper"></span>
        <span class="env__front"></span>
        <span class="env__flap"></span>
        <span class="env__seal">${tulip("env__tulip")}</span>
        <span class="sr-only">Open the envelope</span>
      </button>
      <p class="aside env__hint">tap to open</p>
    </div>
    <article class="note" id="note" hidden tabindex="-1" aria-label="A letter">
      <p class="note__greet">${esc(n.greeting)}</p>
      ${n.paras.map((p) => `<p>${fmt(p)}</p>`).join("")}
      <p class="note__sign">${esc(n.sign)}</p>
      ${n.ps ? `<p class="note__ps">${fmt(n.ps)}</p>` : ""}
    </article>`);
}

/* ---------- 06 · The Last Page ---------- */

function last({ last: l }) {
  return section("06", "The Last Page", "dark", "sheet--night last", `
    <div class="last__inner">
      <p class="eyebrow" data-reveal>Chapter 06 <span aria-hidden="true">·</span> The Last Page</p>
      <div data-reveal style="--d:150ms">${tulip("last__tulip")}</div>
      <h2 class="last__quote" id="ch06-title" data-reveal style="--d:300ms">${esc(l.quote)}</h2>
      <p class="last__bye" data-reveal style="--d:700ms">${esc(l.bye)}</p>
      <p class="last__sign" data-reveal style="--d:900ms">${esc(l.sign)}</p>
      <button class="ghost" type="button" id="closeBook" data-reveal style="--d:1100ms">Close the book</button>
    </div>`);
}

export function render(content) {
  return [beginning, her, memories, letters, note, last].map((chapter) => chapter(content)).join("");
}
