// Small pen doodles for the margins of the scrapbook.
// All share a 64 × 64 canvas and are drawn with a single stroke weight.

const shapes = {
  follow: `
    <circle cx="26" cy="22" r="9"/>
    <path d="M10 52c1-11 8-17 16-17s15 6 16 17"/>
    <path d="M49 17v14M42 24h14"/>`,

  bubbles: `
    <path d="M11 10h26a5 5 0 0 1 5 5v14a5 5 0 0 1-5 5H22l-8 7v-7h-3a5 5 0 0 1-5-5V15a5 5 0 0 1 5-5z"/>
    <path d="M47 22h5a5 5 0 0 1 5 5v12a5 5 0 0 1-5 5h-1v6l-7-6h-9"/>
    <circle class="dot" cx="17" cy="22" r="1.3"/><circle class="dot" cx="24" cy="22" r="1.3"/><circle class="dot" cx="31" cy="22" r="1.3"/>`,

  window: `
    <rect x="13" y="9" width="38" height="44" rx="2"/>
    <path d="M32 9v44M13 31h38M8 53h48"/>
    <circle cx="41.5" cy="20" r="4"/>
    <path d="M18 25c0-2.5 2-4 4-4 1-2.5 5-2.5 6 0 1.5 0 2.5 1.5 2.5 3"/>
    <path d="M37 37l-3 5M43 37l-3 5M40 44l-2 4"/>`,

  turtle: `
    <path d="M13 41c0-11.5 8.5-20 19-20s19 8.5 19 20z"/>
    <path d="M22 41c1-8 5-13 10-13s9 5 10 13M32 21v7M24.5 24.5l3.5 5M39.5 24.5l-3.5 5"/>
    <path d="M51 37c3.5-3.5 9-2.5 9 1.5S55 44 51 41"/>
    <circle class="dot" cx="56" cy="38" r="1"/>
    <path d="M19 41v5a3 3 0 0 0 6 0v-5M39 41v5a3 3 0 0 0 6 0v-5M13 40l-6 2"/>`,

  starfish: `
    <path d="M32 14l5.3 12.7L51 27.8 40.6 36.8l3.2 13.4L32 43l-11.8 7.2 3.2-13.4L13 27.8l13.7-1.1z"/>
    <circle class="dot" cx="32" cy="24" r=".9"/><circle class="dot" cx="32" cy="33.5" r=".9"/>
    <circle class="dot" cx="40.5" cy="31" r=".9"/><circle class="dot" cx="23.5" cy="31" r=".9"/>
    <circle class="dot" cx="37" cy="42" r=".9"/><circle class="dot" cx="27" cy="42" r=".9"/>`,

  paw: `
    <path d="M32 33c-7 0-12 6-12 11.5 0 4 3 6 6 6 2 0 4-1 6-1s4 1 6 1c3 0 6-2 6-6C44 39 39 33 32 33z"/>
    <ellipse cx="17.5" cy="27" rx="4" ry="5.5" transform="rotate(-20 17.5 27)"/>
    <ellipse cx="27" cy="18" rx="4" ry="5.5" transform="rotate(-6 27 18)"/>
    <ellipse cx="37" cy="18" rx="4" ry="5.5" transform="rotate(6 37 18)"/>
    <ellipse cx="46.5" cy="27" rx="4" ry="5.5" transform="rotate(20 46.5 27)"/>`,

  rain: `
    <path d="M20 36h26a8.5 8.5 0 0 0 1.5-16.9A12 12 0 0 0 24.6 16 10.2 10.2 0 0 0 20 36z"/>
    <path d="M23 43l-3 8M33 43l-3 8M43 43l-3 8"/>`,

  stage: `
    <path d="M8 11h48M8 53h48"/>
    <path d="M12 11v37c8-6 13-19 13-37M52 11v37c-8-6-13-19-13-37"/>
    <path d="M32 27c.8 4.6 2.6 6.4 7 7-4.4.6-6.2 2.4-7 7-.8-4.6-2.6-6.4-7-7 4.4-.6 6.2-2.4 7-7z"/>`,

  cricket: `
    <circle cx="42" cy="40" r="12"/>
    <path d="M33 32.5c6 3 9.5 9 10 18M37 29.5c7 2 12.5 8 14 16"/>
    <g transform="rotate(-38 20 30)"><rect x="15" y="20" width="10" height="28" rx="3"/><path d="M20 20V8"/></g>`,

  cat: `
    <g stroke-linejoin="miter" stroke-linecap="square">
      <rect x="16" y="22" width="32" height="28"/>
      <rect x="16" y="14" width="8" height="8"/><rect x="40" y="14" width="8" height="8"/>
      <rect class="dot" x="24" y="31" width="4" height="6"/><rect class="dot" x="36" y="31" width="4" height="6"/>
      <rect class="dot" x="30" y="41" width="4" height="3"/>
    </g>`,

  bag: `
    <path d="M16 27h32l-3 29H19z"/>
    <path d="M18 27c-3-9 0-14 3-14s5 5 3 14M46 27c3-9 0-14-3-14s-5 5-3 14"/>
    <path d="M26.3 27a7 7 0 1 1 11.4 0"/>
    <circle class="dot" cx="30" cy="20.5" r=".9"/><circle class="dot" cx="34" cy="20.5" r=".9"/><circle class="dot" cx="32" cy="23.8" r=".9"/>`,
};

export function doodle(name) {
  const body = shapes[name];
  if (!body) return "";
  return `<svg class="doodle" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** The one recurring ornament: a single tulip, drawn in line. */
export function tulip(extraClass = "") {
  return `<svg class="tulip ${extraClass}" viewBox="0 0 60 104" aria-hidden="true" focusable="false">
    <path class="tulip__bloom" d="M30 44C20 44 13 36 13 26c0-5 1.5-9 3.5-13 3 2.5 5.5 5.5 7 9C25 16 27 10 30 6c3 4 5 10 6.5 16 1.5-3.5 4-6.5 7-9 2 4 3.5 8 3.5 13 0 10-7 18-17 18z"/>
    <path class="tulip__stem" d="M30 44c0 18-1.5 38 0 56"/>
    <path class="tulip__leaf" d="M30 86c-9-2-15-9-17-20 8 3 15 9 17 20z"/>
    <path class="tulip__leaf" d="M30 76c8-3 13-9 14-18-7 3-13 8-14 18z"/>
  </svg>`;
}
