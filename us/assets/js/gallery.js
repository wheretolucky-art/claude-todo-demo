// The photograph viewer: one polaroid held up close.
// Swipe or use the arrow keys to move between photographs; Esc or a tap outside closes it.

export function initLightbox(urlFor) {
  const box = document.getElementById("lightbox");
  const card = box.querySelector(".lightbox__card");
  const img = document.getElementById("lightboxImg");
  const cap = document.getElementById("lightboxCap");
  const count = document.getElementById("lightboxCount");
  const closeBtn = box.querySelector(".lightbox__close");
  const prevBtn = box.querySelector(".lightbox__nav--prev");
  const nextBtn = box.querySelector(".lightbox__nav--next");

  let items = [];
  let index = 0;
  let opener = null;
  let token = 0;

  async function show(i) {
    index = (i + items.length) % items.length;
    const item = items[index];
    const mine = ++token;
    card.classList.add("is-swapping");
    const url = await urlFor(item.id);
    if (mine !== token) return;
    img.src = url;
    img.alt = item.alt;
    await img.decode().catch(() => {});
    if (mine !== token) return;
    cap.textContent = item.cap || "";
    cap.hidden = !item.cap;
    card.classList.toggle("is-plain", !item.cap);
    count.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : "";
    card.classList.remove("is-swapping");
  }

  function open(list, start, from) {
    items = list;
    opener = from || document.activeElement;
    const many = items.length > 1;
    prevBtn.hidden = nextBtn.hidden = !many;
    box.hidden = false;
    document.documentElement.classList.add("is-viewing");
    requestAnimationFrame(() => box.classList.add("is-open"));
    show(start);
    closeBtn.focus({ preventScroll: true });
  }

  function close() {
    if (box.hidden) return;
    token++;
    box.classList.remove("is-open");
    document.documentElement.classList.remove("is-viewing");
    setTimeout(() => { box.hidden = true; img.removeAttribute("src"); }, 320);
    opener?.focus?.({ preventScroll: true });
  }

  closeBtn.addEventListener("click", close);
  prevBtn.addEventListener("click", () => show(index - 1));
  nextBtn.addEventListener("click", () => show(index + 1));
  box.addEventListener("click", (event) => { if (event.target === box) close(); });

  box.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    else if (event.key === "ArrowLeft" && items.length > 1) show(index - 1);
    else if (event.key === "ArrowRight" && items.length > 1) show(index + 1);
    else if (event.key === "Tab") {
      // Keep focus inside the viewer while it is open.
      const stops = [closeBtn, prevBtn, nextBtn].filter((el) => !el.hidden);
      const at = stops.indexOf(document.activeElement);
      const to = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at === stops.length - 1 ? 0 : at + 1);
      stops[to].focus();
      event.preventDefault();
    }
  });

  // Swipe sideways for the next photograph, down to put it away.
  let startX = 0, startY = 0, tracking = false;
  box.addEventListener("pointerdown", (event) => { tracking = true; startX = event.clientX; startY = event.clientY; });
  box.addEventListener("pointerup", (event) => {
    if (!tracking) return;
    tracking = false;
    const dx = event.clientX - startX, dy = event.clientY - startY;
    if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.4 && items.length > 1) show(index + (dx < 0 ? 1 : -1));
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.4) close();
  });
  box.addEventListener("pointercancel", () => { tracking = false; });

  return { open, close };
}
