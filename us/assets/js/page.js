// Page-level behaviour: photographs that load as they come near, gentle
// reveals, and the running head that knows which chapter you are in.

export const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Decrypts each photograph shortly before it scrolls into view. */
export function initPhotos(root, vault, images) {
  const urlFor = (id) => {
    const entry = images[id];
    return entry ? vault.image(entry.file, entry.type) : Promise.reject(new Error("unknown photo " + id));
  };

  async function load(img) {
    try {
      img.src = await urlFor(img.dataset.photo);
      await img.decode().catch(() => {});
      img.classList.add("is-ready");
    } catch {
      img.closest("figure")?.classList.add("is-missing");
    }
  }

  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      seen.unobserve(entry.target);
      load(entry.target);
    }
  }, { rootMargin: "900px 600px" });

  root.querySelectorAll("img[data-photo]").forEach((img) => seen.observe(img));
  return { urlFor };
}

/** Elements marked data-reveal settle into place the first time they are seen. */
export function initReveal(root) {
  const items = root.querySelectorAll("[data-reveal]");
  if (reduceMotion()) {
    items.forEach((el) => el.classList.add("is-in"));
    return;
  }
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-in");
      seen.unobserve(entry.target);
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
  items.forEach((el) => seen.observe(el));
}

/** Running head: chapter label, light/dark tone, and the reading-progress hairline. */
export function initChrome(root) {
  const where = document.getElementById("where");
  const bar = document.getElementById("progress");
  const chapters = [...root.querySelectorAll("[data-chapter]")];

  function mark(chapter) {
    const label = `${chapter.dataset.no} — ${chapter.dataset.name}`;
    if (where.textContent !== label) where.textContent = label;
    document.body.dataset.tone = chapter.dataset.tone;
  }

  // A chapter is "current" while it crosses a line just below the running head.
  const line = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) mark(entry.target);
  }, { rootMargin: "-12% 0px -87% 0px" });
  chapters.forEach((chapter) => line.observe(chapter));
  if (chapters[0]) mark(chapters[0]);

  let queued = false;
  function measure() {
    queued = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
  }
  addEventListener("scroll", () => {
    if (!queued) { queued = true; requestAnimationFrame(measure); }
  }, { passive: true });
  measure();
}
