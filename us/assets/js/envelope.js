// Chapter 05: an envelope that opens once, and the letter inside it.

import { reduceMotion } from "./page.js";

export function initEnvelope(root) {
  const env = root.querySelector("#env");
  const button = env.querySelector(".env__btn");
  const note = root.querySelector("#note");

  button.addEventListener("click", () => {
    if (env.classList.contains("is-open")) return;
    const still = reduceMotion();
    env.classList.add("is-open");
    button.setAttribute("aria-expanded", "true");

    // Flap lifts, the letter rises, then the envelope steps aside for the page itself.
    setTimeout(() => {
      env.classList.add("is-away");
      setTimeout(() => {
        env.hidden = true;
        note.hidden = false;
        note.focus({ preventScroll: true });
      }, still ? 0 : 420);
    }, still ? 0 : 1500);
  });
}
