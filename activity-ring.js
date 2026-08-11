// activity-ring.js — vanilla JS port of the arc/mask/gradient/rounding
// technique from the local `activity-rings` reference project (MIT, React +
// react-spring). This site has no build step and no React, so this is a
// direct port of its rendering math to plain DOM/SVG calls, dropping only
// the animation (react-spring) and multi-ring nesting (we only ever draw
// one ring per card) — everything else (masking approach, gradient sheen,
// the >100% spin-in-place behavior, the shadowed rounding dot) is the same
// technique, not a redesign of it.
//
// Reference: http://github.com/creewick/activity-rings
// Cloned under:
// activity-rings/src/ActivityRings/ActivityRing.tsx,
// ActivityRingInternal/{ActivityRingArc,ActivityRingArcMask,ActivityRingRounding}.tsx
//
//

const ACTIVITY_RING_SVG_NS = "http://www.w3.org/2000/svg";
let activityRingUid = 0;

function arHexToRgb(hex) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substr(0, 2), 16),
    parseInt(h.substr(2, 2), 16),
    parseInt(h.substr(4, 2), 16),
  ];
}

function arRgbToHex(r, g, b) {
  const toHex = (x) =>
    Math.round(Math.max(0, Math.min(255, x)))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function arRgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

function arHueToRgbChannel(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function arHslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  s /= 100;
  l /= 100;
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    arHueToRgbChannel(p, q, h + 1 / 3) * 255,
    arHueToRgbChannel(p, q, h) * 255,
    arHueToRgbChannel(p, q, h - 1 / 3) * 255,
  ];
}

// matches tinycolor2's spin (rotate hue, degrees) + lighten (raise HSL
// lightness by percentage points, capped at 100)
function arSpinLighten(hex, spinDeg, lightenPct) {
  const [h, s, l] = arRgbToHsl(...arHexToRgb(hex));
  const [r, g, b] = arHslToRgb(h + spinDeg, s, Math.min(100, l + lightenPct));
  return arRgbToHex(r, g, b);
}

// matches tinycolor.mix(a, b, weightOfB0to100)
function arMixHex(hexA, hexB, weightBPercent) {
  const [ar, ag, ab] = arHexToRgb(hexA);
  const [br, bg, bb] = arHexToRgb(hexB);
  const t = Math.max(0, Math.min(100, weightBPercent)) / 100;
  return arRgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

function arEl(name, attrs) {
  const el = document.createElementNS(ACTIVITY_RING_SVG_NS, name);
  for (const key in attrs) el.setAttribute(key, attrs[key]);
  return el;
}

/**
 * Draws one activity-ring arc into an existing <svg>, appending everything
 * it needs (defs, mask, gradients, the arc itself, the rounded tip).
 *
 * @param {SVGSVGElement} svg  target <svg>, expected viewBox "0 0 100 100"
 * @param {object} opts
 * @param {number} opts.value  progress, where 1 = a full circle (unclamped
 *                             — values over 1 spin the ring further, per
 *                             ActivityRingArc's rotateAngle behavior)
 * @param {string} opts.color  base ring color, hex
 * @param {number} [opts.cx]
 * @param {number} [opts.cy]
 * @param {number} [opts.radius]
 * @param {number} [opts.width] ring thickness
 */
function drawActivityRing(svg, opts) {
  const { value, color, cx = 50, cy = 50, radius = 44, width = 10 } = opts;
  const uid = activityRingUid++;

  const arcAngle = value * 2 * Math.PI;
  const startX = cx;
  const startY = cy - radius;
  const endX = cx + radius * Math.sin(arcAngle);
  const endY = cy - radius * Math.cos(arcAngle);

  const color2 = arSpinLighten(color, -5, 5);
  const color3 = arSpinLighten(color, -10, 10);
  const colorCurrent = arMixHex(color, color3, Math.min(100, value * 100));

  const maskId = `ar-mask-${uid}`;
  const grad1Id = `ar-grad1-${uid}`;
  const grad2Id = `ar-grad2-${uid}`;
  const shadowId = `ar-shadow-${uid}`;

  const defs = arEl("defs", {});
  svg.appendChild(defs);

  // mask: reveals either the value-fraction arc, or (once >= 1 full lap)
  // the whole circle, out of the two full gradient semicircles below
  const mask = arEl("mask", {
    id: maskId,
    x: -width,
    y: -width,
    width: 100,
    height: 100,
  });
  mask.appendChild(
    arEl("circle", {
      cx,
      cy,
      r: radius,
      stroke: "#222",
      "stroke-width": width,
      fill: "none",
    }),
  );
  if (value >= 1) {
    mask.appendChild(
      arEl("circle", {
        cx,
        cy,
        r: radius,
        stroke: "white",
        "stroke-width": width,
        fill: "none",
      }),
    );
  } else {
    const largeArc = value > 0.5 ? 1 : 0;
    mask.appendChild(
      arEl("path", {
        d: `M ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY}`,
        stroke: "white",
        "stroke-width": width,
        fill: "none",
      }),
    );
  }
  defs.appendChild(mask);

  // gradient sheen: color -> color2 (top half), color2 -> color3 (bottom half)
  function linearGradient(id, from, to, y1, y2) {
    const g = arEl("linearGradient", { id, x1: "0%", x2: "0%", y1, y2 });
    g.appendChild(arEl("stop", { offset: "0%", "stop-color": from }));
    g.appendChild(arEl("stop", { offset: "100%", "stop-color": to }));
    return g;
  }
  defs.appendChild(linearGradient(grad1Id, color, color2, "0%", "100%"));
  defs.appendChild(linearGradient(grad2Id, color2, color3, "100%", "0%"));

  // the ring is always drawn as a complete circle (two gradient halves);
  // the mask above is what actually limits it to `value` while < 1. Once
  // value >= 1, the mask reveals the whole thing and instead this group is
  // rotated by the total angle traveled, so the gradient sheen visibly
  // keeps spinning to show continued progress past a full lap.
  const rotateDeg = value < 1 ? 0 : (arcAngle * 180) / Math.PI;
  const arcGroup = arEl("g", {
    mask: `url(#${maskId})`,
    transform: `rotate(${rotateDeg} ${cx} ${cy})`,
  });
  function arcHalf(fromY, toY, gradId) {
    return arEl("path", {
      d: `M ${cx} ${fromY} A ${radius} ${radius} 0 0 1 ${cx} ${toY}`,
      "stroke-width": width,
      stroke: `url(#${gradId})`,
      fill: "none",
    });
  }
  arcGroup.appendChild(arcHalf(cy - radius, cy + radius, grad1Id));
  arcGroup.appendChild(arcHalf(cy + radius, cy - radius, grad2Id));
  svg.appendChild(arcGroup);

  // rounded ends: a plain dot at the (fixed) start once there's a visible
  // gap to mark, and a shadowed dot at the (moving, wraps naturally past
  // 100% since sin/cos are periodic) current tip — the dot's overlap with
  // the flat-ended stroke beneath it is what makes it read as a round cap,
  // no manual semicircle geometry needed
  if (value > 0) {
    if (value < 1) {
      svg.appendChild(
        arEl("circle", { cx: startX, cy: startY, r: width / 2, fill: color }),
      );
    }
    const shadowDx = Math.cos(arcAngle) * (width * 0.05);
    const shadowDy = Math.sin(arcAngle) * (width * 0.05);
    const filter = arEl("filter", {
      id: shadowId,
      x: "-50%",
      y: "-50%",
      width: "200%",
      height: "200%",
    });
    filter.appendChild(
      arEl("feDropShadow", {
        dx: shadowDx.toFixed(3),
        dy: shadowDy.toFixed(3),
        stdDeviation: (width * 0.03).toFixed(3),
        "flood-color": "#000000",
        "flood-opacity": "0.5",
      }),
    );
    defs.appendChild(filter);
    svg.appendChild(
      arEl("circle", {
        cx: endX,
        cy: endY,
        r: width / 2 - 0.2,
        fill: colorCurrent,
        filter: `url(#${shadowId})`,
      }),
    );
  }
}
