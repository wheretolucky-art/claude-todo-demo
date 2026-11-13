// Music: off until asked for. Nothing is downloaded and nothing plays on its own.
//
// Instead of a recording, a quiet music-box figure is synthesised in the
// browser: a slow four-chord turn in F, picked out one note at a time.
//
// To use a real track instead, put an audio file next to index.html and set
// TRACK to its name (for example "song.mp3"); it will loop quietly.

const TRACK = null;

const STEP = 0.46;                       // seconds per eighth note (about 65 bpm)
const CHORDS = [                         // MIDI notes: bass, then the tones the box picks from
  { bass: 41, tones: [65, 69, 72, 76, 81] },   // F  maj7
  { bass: 38, tones: [65, 69, 72, 74, 77] },   // D  min7
  { bass: 34, tones: [65, 70, 74, 77, 82] },   // B♭ maj7
  { bass: 36, tones: [64, 67, 72, 76, 79] },   // C
];
const FIGURE = [0, 2, 3, 1, 4, 2, 3, 1, 0, 3, 2, 4, 3, 1, 2, null];   // two bars; null is a rest

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

export function initMusic(button, label) {
  let ctx, master, bus, timer, nextAt = 0, step = 0;
  let audio;
  let on = false;

  function reverbImpulse(seconds) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3.2;
    }
    return impulse;
  }

  function setUp() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    bus = ctx.createBiquadFilter();           // soften the top end
    bus.type = "lowpass";
    bus.frequency.value = 3400;

    const dry = ctx.createGain();
    dry.gain.value = 0.75;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    const room = ctx.createConvolver();
    room.buffer = reverbImpulse(3.2);

    bus.connect(dry).connect(master);
    bus.connect(room).connect(wet).connect(master);
  }

  // One note of the music box: a sine with a little octave shimmer and a long fall.
  function pluck(at, midi, level, length = 2.8) {
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(level, at + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, at + length);
    env.connect(bus);

    for (const [ratio, gain] of [[1, 1], [2, 0.22], [3.01, 0.05]]) {
      const osc = ctx.createOscillator();
      const part = ctx.createGain();
      osc.frequency.value = hz(midi) * ratio;
      part.gain.value = gain;
      osc.connect(part).connect(env);
      osc.start(at);
      osc.stop(at + length + 0.05);
    }
  }

  function schedule() {
    while (nextAt < ctx.currentTime + 0.5) {
      const bar = Math.floor(step / FIGURE.length);
      const chord = CHORDS[bar % CHORDS.length];
      const pos = step % FIGURE.length;
      const pick = FIGURE[pos];
      const drift = (Math.random() - 0.5) * 0.02;            // a human hand is never exactly on time

      if (pos === 0 || pos === 8) pluck(nextAt, chord.bass + 12, 0.22, 4.2);
      if (pick !== null && !(pos % 2 && Math.random() < 0.18)) {
        pluck(nextAt + drift, chord.tones[pick], pos % 4 === 0 ? 0.17 : 0.12);
      }
      nextAt += STEP;
      step += 1;
    }
  }

  function start() {
    if (TRACK) {
      audio ??= Object.assign(new Audio(TRACK), { loop: true, volume: 0.45 });
      audio.play().catch(() => {});
      return;
    }
    if (!ctx) setUp();
    ctx.resume();
    nextAt = ctx.currentTime + 0.15;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 1.8);
    clearInterval(timer);
    timer = setInterval(schedule, 120);
    schedule();
  }

  function stop() {
    if (TRACK) { audio?.pause(); return; }
    if (!ctx) return;
    clearInterval(timer);
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.9);
    setTimeout(() => { if (!on || document.hidden) ctx.suspend(); }, 1000);
  }

  function set(state) {
    on = state;
    button.setAttribute("aria-pressed", String(on));
    button.classList.toggle("is-on", on);
    label.textContent = on ? "Music on" : "Music off";
    if (on) start(); else stop();
  }

  button.addEventListener("click", () => set(!on));

  // Never keep playing in a tab nobody is looking at.
  document.addEventListener("visibilitychange", () => {
    if (!on) return;
    if (document.hidden) stop(); else start();
  });

  return { set, get on() { return on; } };
}
