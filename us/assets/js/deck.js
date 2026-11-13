// The scrapbook: a row of memory cards you flip through sideways.
// Scrolling is native (touch, trackpad, keyboard); this only keeps the counter,
// the arrow buttons and the "current card" highlight in step with it.

import { reduceMotion } from "./page.js";

export function initDeck(root) {
  const track = root.querySelector(".deck__track");
  const cards = [...track.querySelectorAll(".memo")];
  const now = root.querySelector('[data-deck="now"]');
  const prev = root.querySelector('[data-deck="prev"]');
  const next = root.querySelector('[data-deck="next"]');
  let index = 0;

  function setActive(i) {
    index = i;
    cards.forEach((card, n) => card.classList.toggle("is-active", n === i));
    now.textContent = String(i + 1).padStart(2, "0");
    prev.disabled = i === 0;
    next.disabled = i === cards.length - 1;
  }

  function go(i) {
    const card = cards[Math.max(0, Math.min(cards.length - 1, i))];
    const left = card.offsetLeft - (track.clientWidth - card.offsetWidth) / 2;
    track.scrollTo({ left, behavior: reduceMotion() ? "auto" : "smooth" });
  }

  // Whichever card sits nearest the middle of the track is the current one.
  let queued = false;
  function settle() {
    queued = false;
    const mid = track.scrollLeft + track.clientWidth / 2;
    let best = 0, bestGap = Infinity;
    cards.forEach((card, n) => {
      const gap = Math.abs(card.offsetLeft + card.offsetWidth / 2 - mid);
      if (gap < bestGap) { bestGap = gap; best = n; }
    });
    if (best !== index) setActive(best);
  }
  track.addEventListener("scroll", () => {
    if (!queued) { queued = true; requestAnimationFrame(settle); }
  }, { passive: true });

  prev.addEventListener("click", () => go(index - 1));
  next.addEventListener("click", () => go(index + 1));
  track.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") { go(index + 1); event.preventDefault(); }
    else if (event.key === "ArrowLeft") { go(index - 1); event.preventDefault(); }
  });

  setActive(0);
}
