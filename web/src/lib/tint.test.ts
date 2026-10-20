import { describe, expect, it } from "vitest";

import { PROJECT_COLORS, withAlpha } from "./model";
import {
  contrast,
  MIN_CONTRAST,
  SELECT_CONTRAST,
  tint,
  type TintLook,
} from "./tint";

type Rgb = [number, number, number];

const PAPER: Rgb = [0xf6, 0xf1, 0xe3];
const INK = "#2b2a26";

const rgbOf = (hex: string): Rgb => {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** what a look's translucent background looks like laid over the paper */
const seen = (l: TintLook): Rgb => {
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(l.bg);
  if (m === null) throw new Error(`unexpected bg ${l.bg}`);
  const a = Number(m[4]);
  const over = (paper: number, c: string | undefined): number =>
    paper + (Number(c) - paper) * a;
  return [over(PAPER[0], m[1]), over(PAPER[1], m[2]), over(PAPER[2], m[3])];
};

const hexByte = (v: number): string => v.toString(16).padStart(2, "0");
const STEPS = [0x00, 0x33, 0x66, 0x99, 0xcc, 0xff];
const GREYS = [...STEPS, 0x70, 0x76, 0x7a, 0x80, 0x88].map(
  (v) => `#${hexByte(v).repeat(3)}`,
);
// every 0x33 step per channel (216 colours), plus mid-greys, where neither
// dark nor light text reads best
const COLORS = [
  ...STEPS.flatMap((r) =>
    STEPS.flatMap((g) =>
      STEPS.map((b) => `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`),
    ),
  ),
  ...GREYS,
];
const ALPHAS = [0, 0.1, 0.28, 0.45, 0.6, 0.67, 0.75, 0.9, 1];

describe("tint", () => {
  it("keeps every text colour readable on both looks, resting or selected", () => {
    const failures: string[] = [];
    for (const rgb of COLORS)
      for (const alpha of ALPHAS) {
        const t = tint(withAlpha(rgb, alpha));
        if (t === null) throw new Error(`no tint for ${rgb}`);
        for (const name of ["open", "done"] as const)
          for (const [state, bg] of [
            ["resting", seen(t[name])],
            ["selected", rgbOf(t[name].selected)],
          ] as const)
            for (const role of ["fg", "muted"] as const) {
              const ratio = contrast(rgbOf(t[name][role]), bg);
              if (ratio < MIN_CONTRAST)
                failures.push(
                  `${rgb}@${String(alpha)} ${name} ${state} ${role} ${ratio.toFixed(2)}`,
                );
            }
      }
    expect(failures).toEqual([]);
  });

  it("always sets a selected task visibly apart from the resting ones", () => {
    const failures: string[] = [];
    for (const rgb of COLORS)
      for (const alpha of ALPHAS) {
        const t = tint(withAlpha(rgb, alpha));
        if (t === null) throw new Error(`no tint for ${rgb}`);
        for (const name of ["open", "done"] as const) {
          // hex rounding may shave off a hair
          const apart = contrast(rgbOf(t[name].selected), seen(t[name]));
          if (apart < SELECT_CONTRAST - 0.02)
            failures.push(
              `${rgb}@${String(alpha)} ${name} ${apart.toFixed(3)}`,
            );
        }
      }
    expect(failures).toEqual([]);
  });

  it("darkens the selection under light text", () => {
    // black at 67%, as on the real sheet
    const t = tint("#000000ab");
    if (t === null) throw new Error("no tint");
    const lum = (hex: string) => rgbOf(hex).reduce((s, v) => s + v, 0);
    expect(lum(t.open.selected)).toBeLessThan(
      seen(t.open).reduce((s, v) => s + v, 0),
    );
  });

  it("switches to bright text on dark tints and keeps ink on light ones", () => {
    expect(tint("#1a1a40ff")?.open.fg).not.toBe(INK);
    expect(tint("#ffeeaaff")?.open.fg).toBe(INK);
  });

  it("leaves the default palette strength in plain ink", () => {
    for (const c of PROJECT_COLORS) expect(tint(c)?.open.fg).toBe(INK);
  });

  it("changes text gradually, never back and forth, while sliding opacity", () => {
    const sweep = [
      ...GREYS,
      ...PROJECT_COLORS,
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#ffff00",
      "#ff9900",
    ];
    const problems: string[] = [];
    for (const rgb of sweep) {
      const left = new Set<string>();
      let prev: TintLook | undefined;
      for (let a = 0; a <= 255; a++) {
        const l = tint(withAlpha(rgb, a / 255))?.open;
        if (l === undefined) throw new Error(`no tint for ${rgb}`);
        if (prev !== undefined && l.fg !== prev.fg) {
          if (left.has(l.fg)) problems.push(`${rgb}@${String(a)} fg back`);
          left.add(prev.fg);
        } else if (prev !== undefined) {
          // same main colour: secondary colours may only drift
          const [r, g, b] = rgbOf(l.muted);
          const [pr, pg, pb] = rgbOf(prev.muted);
          const jump = Math.max(
            Math.abs(r - pr),
            Math.abs(g - pg),
            Math.abs(b - pb),
          );
          if (jump > 16)
            problems.push(`${rgb}@${String(a)} muted jumps ${String(jump)}`);
        }
        prev = l;
      }
    }
    expect(problems).toEqual([]);
  });

  it("has no tint for a missing or unparsable colour", () => {
    expect(tint(undefined)).toBeNull();
    expect(tint("tomato")).toBeNull();
  });
});
