import { splitAlpha, tintColor } from "./model";

// A project colour tints a task's background. A tint has exactly two looks:
// open, and crossed out (the same colour, faded). Hover and selection never
// change the background — they are drawn with shadows and rings — so each
// look has one background and one set of text colours that reads on it.

/** WCAG AA for normal text */
export const MIN_CONTRAST = 4.5;

/** a crossed-out task keeps this share of its tint's opacity */
const DONE_FADE = 0.5;

type Rgb = readonly [number, number, number];

// keep in sync with --paper, --ink and --pencil in app.css
const PAPER: Rgb = [0xf6, 0xf1, 0xe3];
const INK: Rgb = [0x2b, 0x2a, 0x26];
const PENCIL: Rgb = [0x8a, 0x85, 0x78];
/** bright text for dark tints: paper-white rather than stark #fff */
const LIGHT: Rgb = [0xfd, 0xfb, 0xf5];
/** pencil as it reads on dark tints */
const LIGHT_PENCIL: Rgb = [0xd2, 0xcb, 0xb8];
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [0xff, 0xff, 0xff];

/** Background and text colours of one look of a tinted task. */
export interface TintLook {
  /** translucent background, as painted */
  bg: string;
  /** opaque background of the selected task: visibly apart from `bg` */
  selected: string;
  /** main text */
  fg: string;
  /** secondary text: project tag, dates, crossed-out words */
  muted: string;
}

/** how far a selected background stands apart from the resting one */
export const SELECT_CONTRAST = 1.35;

export interface Tint {
  open: TintLook;
  done: TintLook;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** WCAG relative luminance of an sRGB colour (channels 0..255). */
function luminance(c: Rgb): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const reads = (c: Rgb, bg: Rgb, target = MIN_CONTRAST): boolean =>
  contrast(c, bg) >= target;

/**
 * Main text for a background. Dark or light is decided by which of black and
 * white contrasts more — a single threshold, so sliding a tint's opacity
 * flips the text once. Within that side: ink or paper-white if they read,
 * else pure black or white, one of which always clears 4.58:1.
 */
function mainText(bg: Rgb): Rgb {
  const dark = contrast(BLACK, bg) >= contrast(WHITE, bg);
  const soft = dark ? INK : LIGHT;
  if (reads(soft, bg)) return soft;
  return dark ? BLACK : WHITE;
}

const round = (c: Rgb): Rgb => [
  Math.round(c[0]),
  Math.round(c[1]),
  Math.round(c[2]),
];

/**
 * `preferred` if it reaches `target` contrast; else mixed toward `fg` just
 * far enough (or fg itself, if even that falls short). Varies smoothly with
 * the background.
 */
function readable(preferred: Rgb, fg: Rgb, bg: Rgb, target: number): Rgb {
  if (reads(preferred, bg, target)) return preferred;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const t = (lo + hi) / 2;
    if (reads(mix(preferred, fg, t), bg, target)) hi = t;
    else lo = t;
  }
  // hex digits round each channel: creep further toward fg until the
  // rounded colour still reaches the target, rather than jumping to fg
  for (let t = hi; t < 1; t += 1 / 512) {
    const c = round(mix(preferred, fg, t));
    if (reads(c, bg, target)) return c;
  }
  return fg;
}

const hex = (c: Rgb): string =>
  "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/**
 * The nearest point from `bg` toward `target` that stands SELECT_CONTRAST
 * apart from `bg`, or null if even `target` itself does not.
 */
function stepToward(bg: Rgb, target: Rgb): Rgb | null {
  if (contrast(mix(bg, target, 1), bg) < SELECT_CONTRAST) return null;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const t = (lo + hi) / 2;
    if (contrast(mix(bg, target, t), bg) >= SELECT_CONTRAST) hi = t;
    else lo = t;
  }
  return mix(bg, target, hi);
}

/**
 * The selected background. It moves away from the text — darker under light
 * text, lighter under dark text — which only adds contrast. A background
 * already at that end (near-black, near-white) moves toward the text
 * instead, as long as all of `text` still reads.
 */
function selectedBg(bg: Rgb, fg: Rgb, text: readonly Rgb[]): Rgb {
  const away = luminance(fg) < 0.5 ? WHITE : BLACK;
  const apart = stepToward(bg, away);
  if (apart !== null) return apart;
  const toward = stepToward(bg, fg);
  if (toward !== null && text.every((c) => reads(c, toward))) return toward;
  return away; // as far apart as this background can get
}

/**
 * Secondary text keeps a reserve over MIN_CONTRAST, so it still reads once
 * selection moves the background SELECT_CONTRAST closer to it (plus a hair
 * for both colours being rounded to hex).
 */
const LABEL_CONTRAST = MIN_CONTRAST * (SELECT_CONTRAST + 0.02);

function look(rgb: Rgb, alpha: number): TintLook {
  // what the eye sees: the tint laid over the paper
  const bg = mix(PAPER, rgb, alpha);
  const fg = mainText(bg);
  // secondary text stays on fg's side: grey under dark text, its light
  // twin under light text. Overdue dates are not coloured here: near the
  // dark/light switch no red reaches 4.5:1, so they get a red chip instead.
  const dark = luminance(fg) < 0.5;
  const muted = readable(dark ? PENCIL : LIGHT_PENCIL, fg, bg, LABEL_CONTRAST);
  return {
    bg: `rgb(${rgb.join(" ")} / ${String(alpha)})`,
    selected: hex(selectedBg(bg, fg, [fg, muted])),
    fg: hex(fg),
    muted: hex(muted),
  };
}

/** Both looks of a project colour; null when untinted or unparsable. */
export function tint(color: string | undefined): Tint | null {
  if (color === undefined) return null;
  const parts = splitAlpha(tintColor(color));
  if (parts === null) return null;
  const n = parseInt(parts.rgb.slice(1), 16);
  const rgb: Rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return {
    open: look(rgb, parts.alpha),
    done: look(rgb, parts.alpha * DONE_FADE),
  };
}

const LOOKS = ["open", "done"] as const;
const ROLES = ["bg", "selected", "fg", "muted"] as const;

/** The tint as CSS custom properties (--t-<look>-<role>) for a style attribute. */
export function tintStyle(color: string | undefined): string | undefined {
  const t = tint(color);
  if (t === null) return undefined;
  return LOOKS.flatMap((l) =>
    ROLES.map((role) => `--t-${l}-${role}:${t[l][role]}`),
  ).join(";");
}
