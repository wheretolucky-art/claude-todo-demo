// A Little Place Called Us
//
// index.html holds only the cover. Everything personal — the words and the
// photographs — is sealed in pack/ and opened here with the key from the link.

import { openVault, parseKey } from "./vault.js";
import { render } from "./render.js";
import { initCover } from "./cover.js";
import { initPhotos, initReveal, initChrome } from "./page.js";
import { initLightbox } from "./gallery.js";
import { initDeck } from "./deck.js";
import { initBook } from "./book.js";
import { initEnvelope } from "./envelope.js";
import { initMusic } from "./music.js";

const pages = document.getElementById("pages");
const chrome = document.getElementById("chrome");

let book = null;
let started = false;

const cover = initCover({
  onKey: unseal,
  onOpen() {
    pages.hidden = false;
    chrome.hidden = false;
    book?.layout();
    if (!started) {
      started = true;
      initReveal(pages);
      initChrome(pages);
    }
  },
  onOpened() {},
  onClosed() {
    pages.hidden = true;
    chrome.hidden = true;
  },
});

initMusic(document.getElementById("music"), document.getElementById("musicLabel"));

async function unseal(key) {
  cover.busy("One moment…");
  let vault, content;
  try {
    vault = await openVault(key);
    content = await vault.json("content.bin");
  } catch (error) {
    cover.locked(error?.message === "insecure-context"
      ? "This little book only opens over a secure (https) link."
      : "That link doesn’t seem to open this book. Check that all of it was copied.");
    return;
  }

  // Keep the key in the address so a refresh still opens the book.
  try {
    if (parseKey(location.hash) !== key) history.replaceState(null, "", "#" + key);
  } catch {
    // Some file viewers refuse to change the address; the book still opens.
  }

  pages.innerHTML = render(content);

  const photos = initPhotos(pages, vault, content.images);
  const lightbox = initLightbox(photos.urlFor);

  const portraits = content.her.photos.map(({ id, alt, cap }) => ({ id, alt, cap }));
  const keepsakes = content.memories.cards.filter((c) => c.photo).map((c) => ({ id: c.photo, alt: c.alt, cap: "" }));

  pages.addEventListener("click", (event) => {
    const portrait = event.target.closest("[data-open]");
    if (portrait) return lightbox.open(portraits, Number(portrait.dataset.open), portrait);
    const keepsake = event.target.closest("[data-open-photo]");
    if (keepsake) {
      return lightbox.open(keepsakes, keepsakes.findIndex((k) => k.id === keepsake.dataset.openPhoto), keepsake);
    }
    if (event.target.closest("#closeBook")) cover.close();
  });

  initDeck(pages.querySelector("#deck"));
  book = initBook(pages.querySelector("#book"), content.letters.items, content.meta.book);
  initEnvelope(pages);

  cover.ready(content.beginning.dedication);
}

const key = parseKey(location.hash);
if (key) unseal(key);
else cover.locked();
