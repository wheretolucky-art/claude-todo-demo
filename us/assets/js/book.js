// Chapter 04: the letters, set as the pages of a small book.
//
// The text is poured into pages by measuring it, so every page fits whatever
// phone it is opened on — nothing is clipped and nothing needs to scroll.
// Turning is a tap, a swipe, an arrow key, or the buttons underneath.

import { esc, fmt } from "./render.js";

export function initBook(root, letters, bookTitle) {
  const stage = root.querySelector(".book__stage");
  const count = root.querySelector(".book__count");
  const prev = root.querySelector('[data-book="prev"]');
  const next = root.querySelector('[data-book="next"]');
  const hint = root.querySelector(".book__hint");

  let leaves = [];
  let index = 0;
  let measured = "";

  function blankLeaf() {
    const el = document.createElement("article");
    el.className = "leaf";
    el.innerHTML = `
      <p class="leaf__head" aria-hidden="true">${esc(bookTitle)}</p>
      <div class="leaf__text"></div>
      <p class="leaf__foot" aria-hidden="true">0</p>`;
    return el;
  }

  /** Pours the letters into as many pages as the current page size needs. */
  function paginate() {
    const probe = blankLeaf();
    probe.classList.add("leaf--probe");
    stage.append(probe);
    const box = probe.querySelector(".leaf__text");
    const fits = () => box.scrollHeight <= box.clientHeight + 1;

    const pages = [];
    let page;
    const turn = (solo = false) => {
      page = { html: [], body: 0, solo };
      pages.push(page);
      box.textContent = "";
      probe.classList.toggle("leaf--solo", solo);     // measure with the styles the page will really have
    };
    const keep = (node, isBody = true) => { page.html.push(node.outerHTML); if (isBody) page.body += 1; };
    const add = (tag, cls, html) => {
      const node = document.createElement(tag);
      node.className = cls;
      node.innerHTML = html;
      box.append(node);
      return node;
    };

    // Places a run of units (words of a paragraph, lines of a verse), spilling
    // onto the next page when the current one is full.
    function flow(tag, cls, units, join, least, carry) {
      let rest = units;
      let cont = false;
      while (rest.length) {
        const klass = cls + (cont ? " is-cont" : "");
        let node = add(tag, klass, join(rest));
        if (fits()) { keep(node); return; }

        let lo = 0, hi = rest.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          node.innerHTML = join(rest.slice(0, mid));
          if (fits()) lo = mid; else hi = mid - 1;
        }

        let n = Math.min(lo, rest.length - carry);   // never strand a scrap on the next page
        if (n < least) {
          node.remove();
          if (page.body > 0) { turn(); continue; }    // too little room left: begin on a fresh page
          n = Math.max(1, lo);                         // a whole page cannot hold it: take what fits
          node = add(tag, klass, "");
        }
        node.innerHTML = join(rest.slice(0, n));
        keep(node);
        rest = rest.slice(n);
        cont = true;
        turn();
      }
    }

    for (const letter of letters) {
      const solo = letter.blocks.length === 1 && letter.blocks[0].t === "verse";
      turn(solo);
      keep(add("p", "leaf__kicker", esc(letter.kicker)), false);
      keep(add("h3", "leaf__title", esc(letter.title)), false);
      keep(add("div", "leaf__rule", ""), false);

      for (const block of letter.blocks) {
        if (block.t === "verse") {
          flow("p", "verse", block.lines, (lines) => lines.map((l) => `<span>${fmt(l)}</span>`).join(""), 2, 2);
        } else if (block.t === "sign") {
          let node = add("p", "sign", esc(block.text));
          if (!fits() && page.body > 0) {
            // A signature never sits alone: it takes the lines before it along to the next page.
            node.remove();
            const carried = page.body > 1 ? page.html.pop() : null;
            if (carried) page.body -= 1;
            turn();
            if (carried) { box.insertAdjacentHTML("beforeend", carried); page.html.push(carried); page.body += 1; }
            node = add("p", "sign", esc(block.text));
            if (!fits() && carried) {                 // on the very smallest screens even that is too much
              node.remove();
              turn();
              node = add("p", "sign", esc(block.text));
            }
          }
          keep(node);
        } else {
          flow("p", "para", block.text.split(" "), (words) => fmt(words.join(" ")), 8, 4);
        }
      }
    }

    probe.remove();
    return pages;
  }

  function build(pages) {
    leaves.forEach((el) => el.remove());
    leaves = pages.map((page, i) => {
      const el = blankLeaf();
      if (page.solo) el.classList.add("leaf--solo");
      el.style.zIndex = String(pages.length - i);
      el.querySelector(".leaf__text").innerHTML = page.html.join("");
      el.querySelector(".leaf__foot").textContent = String(i + 1);
      stage.append(el);
      return el;
    });
  }

  function show(i) {
    index = Math.max(0, Math.min(leaves.length - 1, i));
    leaves.forEach((el, n) => {
      el.classList.toggle("is-turned", n < index);
      el.setAttribute("aria-hidden", n === index ? "false" : "true");
    });
    count.textContent = `Page ${index + 1} of ${leaves.length}`;
    prev.disabled = index === 0;
    next.disabled = index === leaves.length - 1;
  }

  function turnBy(step) {
    const before = index;
    show(index + step);
    if (index !== before) hint.classList.add("is-done");
  }

  /** (Re)flows the pages when the page size or the fonts have changed. */
  function layout(force = false) {
    const now = `${stage.clientWidth}x${stage.clientHeight}`;
    if (!stage.clientWidth || (!force && now === measured)) return;
    const at = leaves.length > 1 ? index / (leaves.length - 1) : 0;
    measured = now;
    stage.classList.add("is-still");
    build(paginate());
    show(Math.round(at * (leaves.length - 1)));
    requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.remove("is-still")));
  }

  prev.addEventListener("click", () => turnBy(-1));
  next.addEventListener("click", () => turnBy(1));

  stage.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") { turnBy(1); event.preventDefault(); }
    else if (event.key === "ArrowLeft") { turnBy(-1); event.preventDefault(); }
  });

  // Tap the right of the page to go on, the left edge to go back; or swipe.
  let startX = 0, startY = 0, down = false;
  stage.addEventListener("pointerdown", (event) => { down = true; startX = event.clientX; startY = event.clientY; });
  stage.addEventListener("pointercancel", () => { down = false; });
  stage.addEventListener("pointerup", (event) => {
    if (!down) return;
    down = false;
    const dx = event.clientX - startX, dy = event.clientY - startY;
    if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy)) { turnBy(dx < 0 ? 1 : -1); return; }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const rect = stage.getBoundingClientRect();
      turnBy(event.clientX - rect.left < rect.width * 0.3 ? -1 : 1);
    }
  });

  let timer = 0;
  addEventListener("resize", () => { clearTimeout(timer); timer = setTimeout(layout, 180); });

  // Text is measured to fit, so measure again whenever a typeface finishes loading.
  const refit = () => layout(true);
  if (document.fonts) {
    for (const face of ['500 1em "Cormorant Garamond"', 'italic 500 1em "Cormorant Garamond"', '1em "Reenie Beanie"', '500 1em "DM Sans"']) {
      document.fonts.load(face).catch(() => {});
    }
    document.fonts.ready.then(refit);
    document.fonts.addEventListener?.("loadingdone", refit);
  }

  return { layout };
}
