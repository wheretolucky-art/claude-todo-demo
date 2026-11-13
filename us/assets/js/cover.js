// Chapter 01: the cover. A short prelude, the title, and one button.
// The cover swings open like the board of a book, and can be closed again
// from the last page.

import { parseKey } from "./vault.js";
import { reduceMotion } from "./page.js";

const SWING = 1300;   // ms, matches the transition in main.css

export function initCover({ onOpen, onOpened, onClosed, onKey }) {
  const cover = document.getElementById("cover");
  const openBtn = document.getElementById("openBook");
  const wait = document.getElementById("coverWait");
  const dedication = document.getElementById("coverFor");
  const lock = document.getElementById("lock");
  const lockMsg = document.getElementById("lockMsg");
  const lockKey = document.getElementById("lockKey");

  // Play the prelude once. A tap anywhere skips straight to the title.
  const settle = () => cover.classList.add("cover--settled");
  if (reduceMotion()) settle();
  else requestAnimationFrame(() => cover.classList.add("cover--play"));
  cover.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("button, input")) settle();
  });

  openBtn.addEventListener("click", open);

  lock.addEventListener("submit", (event) => {
    event.preventDefault();
    const key = parseKey(lockKey.value);
    if (!key) {
      lockMsg.textContent = "That doesn’t look like the whole link. Try pasting it again.";
      return;
    }
    onKey(key);
  });

  function open() {
    settle();
    onOpen();
    document.body.classList.remove("is-closed");
    scrollTo(0, 0);
    cover.classList.add("cover--open");
    setTimeout(() => {
      cover.hidden = true;
      onOpened();
    }, reduceMotion() ? 0 : SWING);
  }

  function close() {
    cover.hidden = false;
    void cover.offsetWidth;                      // let the browser notice it before it swings shut
    cover.classList.remove("cover--open");
    setTimeout(() => {
      document.body.classList.add("is-closed");
      onClosed();
      scrollTo(0, 0);
      openBtn.focus({ preventScroll: true });
    }, reduceMotion() ? 0 : SWING);
  }

  return {
    open,
    close,
    /** The book is unsealed: show who it is for, and the button. */
    ready(forWhom) {
      dedication.textContent = forWhom;
      wait.hidden = true;
      lock.hidden = true;
      openBtn.hidden = false;
    },
    busy(text) {
      wait.hidden = false;
      wait.textContent = text;
      lock.hidden = true;
    },
    /** No key, or the wrong one: ask for the link. */
    locked(message) {
      settle();
      wait.hidden = true;
      openBtn.hidden = true;
      lock.hidden = false;
      if (message) lockMsg.textContent = message;
    },
  };
}
