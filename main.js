'use strict';
/*
 * Excalidraw Smooth Zoom (Obsidian plugin)
 *
 * Ports the zoom feel of the "Smooth Magnify Zoom" Tampermonkey userscript onto Excalidraw's
 * own camera (appState zoom / scrollX / scrollY), so the canvas really re-renders at the new
 * zoom instead of being magnified like a picture.
 *
 *   Wheel (plain, Ctrl, or Wacom/trackpad pinch)  eased exponential zoom at the cursor
 *   Ctrl + middle-drag up/down                    exponential drag zoom around the press point
 *   Ctrl + pen tip or side button, drag up/down   the same drag zoom with a Wacom (or other) pen
 *   Pen right side button (no Ctrl)               click: Tray mode's Edit menu at the pen; drag: pan
 *   Middle-drag                                   1:1 pan with a captive (locked) cursor, optional
 *   Middle-drag + hold left                       drag zoom around the cross, optional
 *   B / P                                         pen / paint bucket (swapped from Excalidraw's), optional
 *   Shift+wheel and everything else               Excalidraw as normal
 */

const { Plugin: ObsidianPlugin, PluginSettingTab, Setting, ItemView } = require('obsidian');

const VIEW_TYPE      = 'excalidraw';
const MIN_ZOOM       = 0.1;   // Excalidraw's own limits
const MAX_ZOOM       = 30;
const LINE_PX        = 40;    // px per "line" if the device reports line-based deltas
const DRAG_BUTTON    = 1;     // mouse button for pan / drag zoom: 0 = left, 1 = middle, 2 = right
// Ctrl + the pen's tip (0) or either side button drag zooms. Side buttons arrive as middle (1) or
// barrel (2), depending on the driver and how the button is mapped (Wacom settings on Windows,
// GNOME Wacom settings on Linux). The tip press is taken over too, so it never draws a stroke.
const PEN_ZOOM_BUTTONS = [0, 1, 2];
// PointerEvent.button -> the matching PointerEvent.buttons bit (pen eraser is button 5)
const BUTTON_MASK = { 0: 1, 1: 4, 2: 2, 3: 8, 4: 16, 5: 32 };
// Pen side button press -> toggle Tray mode's Edit menu ("Selected shape actions") at the pen.
// The right-click button is the reliable one: on Windows, a side button bound to middle click
// arrives as a faked mouse click that Chromium mostly discards before the page sees it.
const PEN_MENU_GAP = 12;      // px from the pen to the menu's top-left corner
const MENU_MARGIN = 8;        // px kept clear of the drawing's edges
// CSS classes (styles.css). The floating menu's own panel look lives there; only its position
// and width, which change as it moves, are set from code.
const CLS = {
  float: 'ess-floating-menu',
  panCursor: 'ess-pan-cursor',
  panCursorInverted: 'ess-pan-cursor--inverted',
  panCursorIcon: 'ess-pan-cursor--icon',
  numberInput: 'ess-number-input',
};
const FLOAT_KEYS = ['left', 'top', 'width'];   // the inline styles the floating menu gets
// Canvas cursor during a plugin drag. Excalidraw sets the canvas cursor as an inline style, which
// no stylesheet rule can beat without !important, so this one is set inline too and handed back
// to Excalidraw's own value when the drag ends.
const DRAG_CURSOR = { zoom: 'zoom-in', pan: 'grabbing' };

// A Ctrl right-click this soon after the pen was active over a drawing is the pen's barrel
// button, so its context menu is eaten (drivers can send it before the press, or as a mouse click).
const PEN_RECENT_MS = 1000;
const CACHE_RESET_MS = 300;   // like native zoom: draw from stretched bitmap caches while zooming,
                              // re-rasterise crisp once the zoom has been still this long
// Wheel easing follows the tick rate (after Firefox's smooth scrolling): the easing time is
// TICK_RATE_RATIO x the average gap between the last 3 ticks, kept between the fast easing
// (FAST_SMOOTHING_RATIO x Smoothing: 25 ms at the default 80)
// and Smoothing. A new scroll starts as if its previous ticks had been slow, so the first tick
// always gets the full glide and a fast spin ramps up over a few ticks.
const TICK_RATE_RATIO = 0.5;
const FAST_SMOOTHING_RATIO = 0.3125;
// Zoom speed is shown as a multiplier; 1.00 is ZOOM_SPEED_UNIT zoom per pixel of wheel delta.
const ZOOM_SPEED_UNIT = 0.001;
const HISTORY        = 32;    // recent writes remembered (React applies them a frame or two late,
                              // and panning can write several times a frame)

const DEFAULTS = {
  plainWheelZooms:     true,
  zoomSpeed:           1,      // x ZOOM_SPEED_UNIT zoom per pixel of wheel delta
  smoothingMs:         80,     // wheel zoom easing for slow, single ticks (fast spins: x0.3125)
  wheelBounceMs:       120,    // ignore a reverse wheel tick this soon after the last tick (0 = off)
  captivePan:          true,   // middle-drag pans with the cursor locked, so it never leaves the canvas
  panSpeed:            1.0,    // 1 = the canvas follows the hand exactly
  panShowCursor:       false,  // draw a virtual cursor at the press point while it's locked
  panCursorType:       'cross',// one of PAN_CURSORS
  panCursorSize:       22,     // px
  chordZoom:           true,   // middle-drag pan, then hold left too = drag zoom
  swapPenBucketKeys:   true,   // B = pen, P = paint bucket
  penMenu:             true,   // pen side button click toggles Tray mode's Edit menu at the pen
  penClickSlop:        8,      // px the pen may move and still count as a click (further = pan)
  dragZoom:            true,
  dragZoomSpeed:       0.01,   // exponential, per pixel of vertical movement (100 px ≈ 2.7x)
  dragZoomUpZoomsIn:   true,
  dragZoomSmoothingMs: 0.15,   // 0 = zoom tracks the mouse instantly
  dragZoomInfinite:    false,  // lock + hide the cursor while drag zooming, like Blender
  debug:               false,
};

const clamp    = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round6   = v => Math.round(v * 1e6) / 1e6;   // Excalidraw normalises zoom to 6 decimals
const near     = (a, b) => Math.abs(a - b) <= 1e-6 * (1 + Math.abs(b));
const isCanvas = el => !!el && el.tagName === 'CANVAS' && el.classList.contains('excalidraw__canvas');
// The text box Excalidraw lays over the canvas while you edit a text element. It never scrolls
// itself (overflow hidden), so the wheel over it should zoom like the canvas around it.
const isTextEditor = el => !!el && el.tagName === 'TEXTAREA' && !!el.dataset && el.dataset.type === 'wysiwyg';
const toPx     = (e, d) => e.deltaMode === 1 ? d * LINE_PX
                         : e.deltaMode === 2 ? d * (e.view || window).innerHeight : d;

// Settings saved before v2 stored every value, defaults included. Where a default has since
// changed, a saved value still equal to the old default was never really chosen, so it's dropped
// and the new default applies. From v2 on, only values that differ from the defaults are saved.
// Before v3, Zoom speed was stored raw (0.001 = today's 1.00).
const SETTINGS_VERSION = 3;
const OLD_DEFAULTS_V1 = { chordZoom: false, panShowCursor: true };

// ─── Virtual panning cursors ──────────────────────────────────────────────────
// Drawn at the press point while the real cursor is locked and hidden. Each draw(add, size)
// adds its shapes and returns the box size, the hotspot (the point that sits on the press
// point), and how it's painted: inverted (white with the "difference" blend mode, flipping the
// colours beneath it) or as an outlined icon that shows on any background.
const BAR_RATIO = 11;     // line thickness of the inverted shapes is size / 11 (2 px at 22)

// An n x n box whose bars are `bar` px thick and exactly centred on whole pixels.
const pxBox = size => {
  const bar = Math.max(1, Math.round(size / BAR_RATIO));
  const n = (size - bar) % 2 ? size + 1 : size;
  return { n, bar, c: (n - bar) / 2 };
};
const bar = (add, x, y, w, h) =>
  add('rect', { x, y, width: w, height: h, fill: '#fff', 'shape-rendering': 'crispEdges' });
// Four arms around a centre gap of g px each side.
const arms = (add, n, b, c, g) => {
  const a = c - g;
  bar(add, 0, c, a, b); bar(add, c + b + g, c, a, b);
  bar(add, c, 0, b, a); bar(add, c, c + b + g, b, a);
};
const centred = n => ({ w: n, h: n, hot: [n / 2, n / 2], inverted: true });
// Lucide icons (ISC licence), 24x24, drawn as black strokes with a white halo.
const lucide = paths => ({
  draw(add, size) {
    for (const d of paths) add('path', { d });
    return { w: size, h: size, viewBox: '0 0 24 24', hot: [size / 2, size / 2], icon: true };
  },
});

const PAN_CURSORS = {
  cross: { label: 'Cross (inverted)', draw(add, size) {
    const { n, bar: b, c } = pxBox(size);
    bar(add, 0, c, n, b); bar(add, c, 0, b, n);
    return centred(n);
  } },
  crosshair: { label: 'Crosshair with centre gap (inverted)', draw(add, size) {
    const { n, bar: b, c } = pxBox(size);
    arms(add, n, b, c, Math.max(b, Math.round(n / 6)));
    return centred(n);
  } },
  reticle: { label: 'Reticle (inverted)', draw(add, size) {
    const { n, bar: b, c } = pxBox(size);
    add('circle', { cx: n / 2, cy: n / 2, r: Math.max(b, n * 0.32), fill: 'none', stroke: '#fff', 'stroke-width': b });
    arms(add, n, b, c, Math.max(b, Math.round(n / 8)));
    return centred(n);
  } },
  ring: { label: 'Ring (inverted)', draw(add, size) {
    const { n, bar: b } = pxBox(size);
    add('circle', { cx: n / 2, cy: n / 2, r: (n - b) / 2, fill: 'none', stroke: '#fff', 'stroke-width': b });
    return centred(n);
  } },
  dot: { label: 'Dot (inverted)', draw(add, size) {
    const { n } = pxBox(size);
    add('circle', { cx: n / 2, cy: n / 2, r: Math.max(1, n * 0.2), fill: '#fff' });
    return centred(n);
  } },
  arrow: { label: 'Arrow pointer', draw(add, size) {
    // classic pointer, white with a black edge, hotspot on the tip
    add('path', { d: 'M0 0V16L4.2 12.2L7 18.6L9.6 17.5L6.9 11.3H12Z', fill: '#fff', stroke: '#000',
                  'stroke-width': 1.2, 'stroke-linejoin': 'round' });
    const k = size / 22;
    return { w: 15 * k, h: size, viewBox: '-1.5 -1.5 15 22', hot: [1.5 * k, 1.5 * k] };
  } },
  grab: { label: 'Grab hand', ...lucide([
    'M18 11.5V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1.4',
    'M14 10V8a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2',
    'M10 9.9V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v5',
    'M6 14a2 2 0 0 0-2-2a2 2 0 0 0-2 2',
    'M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-4a8 8 0 0 1-8-8 2 2 0 1 1 4 0',
  ]) },
  hand: { label: 'Open hand', ...lucide([
    'M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2',
    'M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2',
    'M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8',
    'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15',
  ]) },
  move: { label: 'Move arrows', ...lucide([
    'M12 2v20', 'm15 19-3 3-3-3', 'm19 9 3 3-3 3', 'M2 12h20', 'm5 9-3 3 3 3', 'm9 5 3-3 3 3',
  ]) },
};
const SWALLOW_MS = 500;   // after a drag, eat the stray click (and a double-click it could make)

// Excalidraw has the pen (freedraw) on P and the paint bucket (bucketfill) on B. Swapped here.
const KEY_SWAP = { b: 'p', p: 'b' };
const KEY_CODE = { b: 'KeyB', p: 'KeyP' };
const isEditable = el => !!el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);

// ─── Camera: one per Excalidraw view ──────────────────────────────────────────
// Screen <-> scene:  clientX = (sceneX + scrollX) * zoom + offsetLeft
// A zoom keeps scene point (px, py) pinned under screen anchor (ax, ay), the same way the
// userscript pins an unzoomed page point under its anchor. Only the output changed: instead of
// a CSS transform, each frame becomes Excalidraw scroll + zoom.
class Camera {
  constructor(plugin, view) {
    this.plugin = plugin;
    this.view = view;
    this.api = null;
    this.win = window;
    this.scale = 1; this.targetScale = 1;
    this.ax = 0; this.ay = 0;     // anchor on screen
    this.px = 0; this.py = 0;     // scene point pinned under the anchor
    this.offL = 0; this.offT = 0; // canvas position in the window (ribbon, sidebar, tab header)
    this.history = [];
    this.raf = 0; this.lastT = 0; this.cacheTimer = 0;
    this.tickTimes = [];     // last 3 wheel tick times, oldest first (for rate-based easing)
    this.wheelTau = null;    // current wheel easing time, ms
    this.dragging = false;   // Ctrl+middle-drag zoom
    this.panning = false;    // captive middle-drag pan
    this.zStart = 1; this.zDist = 0;
    this.frame = this.frame.bind(this);
  }

  get s() { return this.plugin.settings; }

  // Follow the view's current API (it's recreated when the view loads another drawing).
  bind() {
    const api = this.view.excalidrawAPI;
    if (!api || api.isDestroyed) return false;
    if (api !== this.api) {
      this.stop();
      this.api = api;
      this.history = [];
    }
    this.win = (this.view.containerEl && this.view.containerEl.win) || window;
    return true;
  }

  alive() {
    return !!this.api && !this.api.isDestroyed && this.view.excalidrawAPI === this.api;
  }

  // The camera as it stands right now. If appState shows one of our recent writes, our latest
  // write is the truth (React just hasn't caught up). Anything else means something else moved
  // the camera (zoom-to-fit, keyboard zoom, a native pan...), so adopt it.
  read() {
    const st = this.api.getAppState();
    this.offL = st.offsetLeft || 0;
    this.offT = st.offsetTop || 0;
    const z = st.zoom.value, sx = st.scrollX, sy = st.scrollY;
    if (this.history.some(h => near(h.z, z) && near(h.sx, sx) && near(h.sy, sy))) {
      const h = this.history[this.history.length - 1];
      return { z: h.z, sx: h.sx, sy: h.sy, external: false, zoomChanged: false };
    }
    const zoomChanged = !this.history.some(h => near(h.z, z));
    this.history = [{ z, sx, sy }];
    return { z, sx, sy, external: true, zoomChanged };
  }

  pinAt(x, y, c) {
    this.ax = x; this.ay = y;
    this.px = (x - this.offL) / c.z - c.sx;
    this.py = (y - this.offT) / c.z - c.sy;
  }

  // zooming = false for pure pans: the zoom isn't changing, so leave the bitmap caches alone.
  write(zooming = true) {
    const z  = round6(clamp(this.scale, MIN_ZOOM, MAX_ZOOM));
    const sx = (this.ax - this.offL) / z - this.px;
    const sy = (this.ay - this.offT) / z - this.py;
    const appState = { zoom: { value: z }, scrollX: sx, scrollY: sy };
    if (zooming) appState.shouldCacheIgnoreZoom = true;
    this.api.updateScene({ appState });
    this.history.push({ z, sx, sy });
    if (this.history.length > HISTORY) this.history.shift();
    if (zooming) this.scheduleCacheReset();
  }

  scheduleCacheReset() {
    window.clearTimeout(this.cacheTimer);
    this.cacheTimer = window.setTimeout(() => {
      this.cacheTimer = 0;
      if (this.alive()) this.api.updateScene({ appState: { shouldCacheIgnoreZoom: false } });
    }, CACHE_RESET_MS);
  }

  kick() {
    if (this.raf) return;
    this.lastT = this.win.performance.now();
    this.raf = this.win.requestAnimationFrame(this.frame);
  }

  frame(now) {
    this.raf = 0;
    if (!this.alive()) return;
    const dt = clamp(now - this.lastT, 0, 64);   // rAF time can precede kick() time
    this.lastT = now;

    const c = this.read();
    if (c.external) {
      // Something else moved the camera mid-zoom. A pan: keep zooming around the anchor from
      // where things are now. A zoom (zoom-to-fit, Ctrl+0...): it wins, so stop here.
      this.pinAt(this.ax, this.ay, c);
      if (c.zoomChanged) {
        this.scale = this.targetScale = this.zStart = c.z;
        this.zDist = 0;
        return;
      }
    }

    const smoothing = this.dragging ? this.s.dragZoomSmoothingMs : (this.wheelTau ?? this.s.smoothingMs);
    const k = smoothing > 0 ? 1 - Math.exp(-dt / smoothing) : 1;
    this.scale += (this.targetScale - this.scale) * k;
    const done = Math.abs(this.targetScale - this.scale) <= this.targetScale * 5e-4;
    if (done) this.scale = this.targetScale;
    this.write();
    if (!done) this.raf = this.win.requestAnimationFrame(this.frame);
  }

  stop() {
    if (this.raf) { this.win.cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this.cacheTimer) {
      window.clearTimeout(this.cacheTimer);
      this.cacheTimer = 0;
      if (this.alive()) this.api.updateScene({ appState: { shouldCacheIgnoreZoom: false } });
    }
    this.dragging = this.panning = false;
  }

  // ─── Wheel zoom ───
  wheel(e) {
    if (!this.bind() || this.dragging) return;
    const dy = toPx(e, e.deltaY);
    if (!dy) return;
    const c = this.read();
    if (c.external || !this.raf) this.targetScale = c.z;   // start from what's on screen
    this.scale = c.z;
    this.wheelTau = this.easingForTick(!this.raf);
    // Reversing direction: drop whatever zoom is still pending the other way and start from the
    // zoom on screen. Otherwise fast scrolling leaves the target far ahead, and the view keeps
    // going the old way for a moment after you reverse. Same-direction notches still stack.
    const zoomingIn = dy < 0;
    if (zoomingIn ? this.targetScale < this.scale : this.targetScale > this.scale) this.targetScale = this.scale;
    this.pinAt(e.clientX, e.clientY, c);   // re-anchor at the cursor without a visual jump
    const next = clamp(this.targetScale * Math.exp(-dy * this.s.zoomSpeed * ZOOM_SPEED_UNIT), MIN_ZOOM, MAX_ZOOM);
    if (next === this.targetScale && !this.raf) return;   // at a limit: don't redraw for nothing
    this.targetScale = next;
    this.kick();
  }

  // Easing time for this tick, from the average gap between it and the 3 before it. Firefox's
  // approach: a new scroll begins with imaginary slow ticks, so it ramps up rather than snapping.
  easingForTick(newScroll) {
    const slow = this.s.smoothingMs;
    const fast = slow * FAST_SMOOTHING_RATIO;
    const now = this.win.performance.now();
    if (newScroll || this.tickTimes.length < 3) {
      const gap = slow / TICK_RATE_RATIO;   // the gap that maps to the full glide
      this.tickTimes = [now - 3 * gap, now - 2 * gap, now - gap];
    }
    const avgGap = (now - this.tickTimes[0]) / 3;
    this.tickTimes.shift();
    this.tickTimes.push(now);
    return clamp(avgGap * TICK_RATE_RATIO, fast, slow);
  }

  // ─── Ctrl + drag zoom ───
  startDrag(e) {
    if (!this.bind()) return false;
    const c = this.read();
    this.scale = this.targetScale = this.zStart = c.z;   // cancels any wheel zoom still easing
    this.pinAt(e.clientX, e.clientY, c);                // the zoom grows out of the press point
    this.zDist = 0;
    this.dragging = true;
    return true;
  }

  // dy: vertical mouse movement this event. Returns true once the drag has actually zoomed
  // (so the click that follows gets eaten).
  dragMove(dy) {
    const s = this.s;
    this.zDist += dy;

    // Exponential: the same percentage per pixel at any zoom. Don't bank movement past the
    // zoom limits, so reversing direction responds immediately.
    const sign = s.dragZoomUpZoomsIn ? -1 : 1;
    const sp = s.dragZoomSpeed;
    const dMin = Math.log(MIN_ZOOM / this.zStart) / sp;
    const dMax = Math.log(MAX_ZOOM / this.zStart) / sp;
    this.zDist = clamp(this.zDist * sign, dMin, dMax) * sign;
    const d = this.zDist * sign;
    this.targetScale = clamp(this.zStart * Math.exp(d * sp), MIN_ZOOM, MAX_ZOOM);

    if (s.dragZoomSmoothingMs > 0) this.kick();
    else { this.scale = this.targetScale; this.write(); }   // instant: apply in this event
    return d !== 0;
  }

  endDrag() {
    this.dragging = false;   // any easing left finishes on its own
  }

  // ─── Captive middle-drag pan ───
  // Panning moves the anchor with the hand while the pinned scene point stays put, like the
  // userscript's grab-and-drag. A wheel zoom still easing keeps going around the moving anchor.
  startPan(e) {
    if (!this.bind() || this.dragging) return false;
    const c = this.read();
    if (c.external || !this.raf) this.targetScale = c.z;
    this.scale = c.z;
    this.pinAt(e.clientX, e.clientY, c);
    this.panning = true;
    return true;
  }

  panBy(dx, dy) {
    if (!dx && !dy) return;
    this.ax += dx * this.s.panSpeed;
    this.ay += dy * this.s.panSpeed;
    this.write(false);   // follow the hand directly, no easing
  }

  endPan() {
    this.panning = false;
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────
module.exports = class ExcalidrawSmoothZoom extends ObsidianPlugin {
  async onload() {
    const saved = Object.assign({}, await this.loadData());
    if (!saved._v) {
      for (const k in OLD_DEFAULTS_V1) if (saved[k] === OLD_DEFAULTS_V1[k]) delete saved[k];
    }
    if ((saved._v || 1) < 3 && typeof saved.zoomSpeed === 'number') {   // raw -> multiplier
      saved.zoomSpeed = round6(saved.zoomSpeed / ZOOM_SPEED_UNIT);
    }
    delete saved.fastSmoothingMs;         // retired setting (now Smoothing x 0.3125)
    if ('crossSize' in saved) {           // renamed setting
      if (!('panCursorSize' in saved)) saved.panCursorSize = saved.crossSize;
      delete saved.crossSize;
    }
    delete saved.dragZoomCurve;           // retired setting (drag zoom is always exponential now)
    delete saved._v;
    this.settings = Object.assign({}, DEFAULTS, saved);
    this.cameras = new WeakMap();
    this.drag = null;          // { mode, cam, target, pointerId, cursor, moved, ... }
    this.drain = null;         // pointerId still held after a drag ended (left button of a chord)
    this.clickUntil = 0;       // eat click/auxclick until then (a new press cancels this)
    this.dblUntil = 0;         // eat dblclick until then (a new press doesn't cancel this)
    this.penDragUntil = 0;     // during and just after a pen drag: eat right-clicks and their menus
    this.penAt = -Infinity;    // when the pen last did anything
    this.float = null;         // the Edit menu while it's floated next to the pen
    this.forwarding = false;   // true while handing a swapped key back to Excalidraw
    this.wheelDir = 0;         // direction and time of the last wheel tick acted on (bounce guard)
    this.wheelAt = -Infinity;
    this.addSettingTab(new SmoothZoomSettingTab(this.app, this));
    this.attach(window);
    this.registerEvent(this.app.workspace.on('window-open', (_ww, win) => this.attach(win)));
  }

  // Save only what differs from the defaults, so a changed default reaches settings you never touched.
  saveSettings() {
    const out = { _v: SETTINGS_VERSION };
    for (const k in DEFAULTS) if (this.settings[k] !== DEFAULTS[k]) out[k] = this.settings[k];
    return this.saveData(out);
  }

  onunload() {
    this.endDrag();
    this.stopFloat(true);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const cam = this.cameras.get(leaf.view);
      if (cam) cam.stop();
    }
  }

  // Capture phase on the window runs before Excalidraw's own listeners, like the userscript.
  attach(win) {
    const cap = { capture: true, passive: false };
    this.registerDomEvent(win, 'wheel',         this.onWheel,       cap);
    this.registerDomEvent(win, 'pointerdown',   this.onPointerDown, cap);
    this.registerDomEvent(win, 'pointermove',   this.onPointerMove, cap);
    this.registerDomEvent(win, 'pointerup',     this.onPointerUp,   cap);
    this.registerDomEvent(win, 'pointercancel', this.onPointerUp,   cap);
    this.registerDomEvent(win, 'auxclick',      this.eatClick,      cap);
    this.registerDomEvent(win, 'click',         this.eatClick,      cap);
    this.registerDomEvent(win, 'dblclick',      this.eatClick,      cap);
    this.registerDomEvent(win, 'contextmenu',   this.eatClick,      cap);   // pen barrel = right button
    this.registerDomEvent(win, 'blur',          () => { this.endDrag(); this.drain = null; });
    this.registerDomEvent(win, 'keydown',       this.onKeyDown,     { capture: true });
    this.registerDomEvent(win.document, 'pointerlockchange', this.onLockChange);
  }

  // The camera for the Excalidraw canvas under `target`, or null if it isn't one. Checking for
  // the canvas itself keeps toolbars, the library, sidebars and embedded notes scrolling normally.
  // `textToo` also accepts the text box of a text element being edited (wheel zoom only: clicks
  // and drags in it stay Excalidraw's, for selecting and editing text).
  cameraAt(target, textToo = false) {
    if (!isCanvas(target) && !(textToo && isTextEditor(target))) return null;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (!view || !view.excalidrawAPI || !view.containerEl.contains(target)) continue;
      let cam = this.cameras.get(view);
      if (!cam) { cam = new Camera(this, view); this.cameras.set(view, cam); }
      return cam;
    }
    return null;
  }

  onWheel = e => {
    const d = this.drag;
    if (d) {
      e.preventDefault();
      e.stopImmediatePropagation();
      // Mid-pan the wheel zooms at the (locked) cursor, as it does during a native pan.
      // Mid drag-zoom it stays out of the way.
      if (d.mode === 'pan' && e.deltaY && !e.shiftKey) d.cam.wheel(e);
      return;
    }
    // Shift pans, horizontal-only wheels pan, and a wheel while some other drag is going
    // (MMB pan, drawing...) is left to Excalidraw, which already handles those cases.
    if (e.shiftKey || e.buttons || !e.deltaY) return;
    const zoomKey = e.ctrlKey || e.metaKey;   // Ctrl+wheel is also how Wacom/trackpad pinch arrives
    if (!zoomKey && !this.settings.plainWheelZooms) return;
    const cam = this.cameraAt(e.target, true);
    if (!cam) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (this.settings.debug) {
      console.debug('[excalidraw-smooth-zoom] wheel', {
        deltaY: e.deltaY, deltaMode: e.deltaMode, ctrl: e.ctrlKey, px: toPx(e, e.deltaY),
      });
    }
    // Wheel bounce: many wheels report the odd tick the wrong way when spun fast. A reverse tick
    // this soon after the last one is ignored; a real reversal gets through once the old
    // direction's ticks stop. Not for Ctrl+wheel, which is also how pinch arrives (pinches
    // reverse smoothly and deliberately).
    const dir = Math.sign(e.deltaY), now = performance.now();
    const guard = this.settings.wheelBounceMs;
    if (guard > 0 && !zoomKey && this.wheelDir && dir !== this.wheelDir && now - this.wheelAt < guard) {
      this.log(`wheel: ignored a reverse tick ${Math.round(now - this.wheelAt)} ms after the last one (wheel bounce)`);
      return;                          // already prevented, so Excalidraw doesn't get it either
    }
    this.wheelDir = dir;
    this.wheelAt = now;
    cam.wheel(e);
  };

  onPointerDown = e => {
    const s = this.settings;
    if (s.debug) {
      console.debug('[excalidraw-smooth-zoom] pointerdown', {
        pointerType: e.pointerType, button: e.button, buttons: e.buttons, ctrl: e.ctrlKey,
      });
    }
    if (this.eatPenRightClick(e)) return;
    this.clickUntil = 0;               // a click that never came doesn't get to eat a later one
    if (this.drag) return;
    if (this.closeFloatOnOutsidePress(e)) return;
    const pen = e.pointerType === 'pen';
    if (pen) this.penAt = performance.now();
    // Pen side button, no modifiers, Tray mode:
    //   right-click button on the drawing: a click toggles the Edit menu, a drag pans. Which one is
    //     decided once the pen moves past the click threshold (mode 'press' until then). The press
    //     is swallowed either way: the Edit menu replaces the pen's right-click menu, and Excalidraw
    //     would otherwise select whatever is under the pen, ready for that menu.
    //   right-click button elsewhere (e.g. on the floating menu): toggles it on the press.
    //   middle button, when the driver reports one: toggles it on the press, which goes on to
    //     Excalidraw (natively a no-op).
    let pressRoot = null;
    if (pen && s.penMenu && (e.button === 2 || e.button === DRAG_BUTTON) &&
        !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      const view = this.viewAt(e.target);
      const root = view && this.trayRoot(view, e.target);   // not in Tray mode: normal behaviour
      if (root && e.button === 2 && isCanvas(e.target)) {
        pressRoot = root;
      } else if (root) {
        if (e.button === 2) {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.drain = e.pointerId;          // eat the rest of this press, up to its release
          this.penDragUntil = Infinity;      // and the context menu it brings (at press or release)
        }
        this.toggleTrayMenu(view.excalidrawAPI, root, e.clientX, e.clientY);
        return;
      }
    }
    let mode = pressRoot ? 'press' : null;
    if (!mode && e.pointerType === 'mouse' && e.button === DRAG_BUTTON) {
      // Hold-left-to-zoom needs the plugin to run the pan, so it takes over even if the pan isn't captive.
      mode = e.ctrlKey ? (s.dragZoom && 'zoom') : ((s.captivePan || s.chordZoom) && 'pan');
    } else if (!mode && pen && e.ctrlKey && PEN_ZOOM_BUTTONS.includes(e.button)) {
      mode = s.dragZoom && 'zoom';
    }
    if (!mode) return;                 // left to Excalidraw (incl. its own middle-button pan)
    const cam = this.cameraAt(e.target);
    const started = cam && (mode === 'zoom' ? cam.startDrag(e) : mode === 'pan' ? cam.startPan(e) : cam.bind());
    if (!started) return;
    // Cancelling pointerdown also stops the compatibility mousedown, so Excalidraw never
    // starts its own middle-button pan.
    e.preventDefault();
    e.stopImmediatePropagation();
    const target = e.target;
    this.drag = { mode, cam, target, pointerId: e.pointerId, cursor: target.style.cursor,
                  moved: false, lastX: e.clientX, lastY: e.clientY, skipNext: false,
                  pressX: e.clientX, pressY: e.clientY, standIn: null,
                  mask: BUTTON_MASK[e.button],                  // the button that holds the drag
                  pen, root: pressRoot,
                  chordable: mode === 'pan' && s.chordZoom,   // hold left to zoom
                  chorded: false,
                  showCross: mode === 'pan' && s.captivePan && s.panShowCursor };
    if (pen) this.penDragUntil = Infinity;
    try { target.setPointerCapture(e.pointerId); } catch (_) {
      // Already released (the button came up first): the window listeners still see the moves.
    }
    if (mode !== 'press') this.setDragCursor(target, mode);
    // A pen points at an absolute spot, so it's never locked (it can't run off the canvas anyway).
    const lock = !pen && (mode === 'zoom' ? s.dragZoomInfinite : s.captivePan);
    if (lock && target.requestPointerLock) {
      try {
        const r = target.requestPointerLock();
        if (r && r.catch) r.catch(() => { /* refused: fall back to normal dragging */ });
      } catch (_) {
        // Refused outright (older Electron throws): fall back to normal dragging.
      }
    }
  };

  // Mouse movement this event. Locked: the cursor is frozen, so use raw movement.
  // Unlocked: use the cursor position.
  moveDelta(d, e) {
    let dx, dy;
    if (d.target.ownerDocument.pointerLockElement === d.target) {
      dx = e.movementX || 0;
      dy = e.movementY || 0;
      if (d.skipNext || Math.abs(dx) >= 400 || Math.abs(dy) >= 400) {   // bogus jump as the lock engages
        d.skipNext = false;
        dx = dy = 0;
      }
    } else {
      dx = e.clientX - d.lastX;
      dy = e.clientY - d.lastY;
    }
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    return [dx, dy];
  }

  onPointerMove = e => {
    if (e.pointerType === 'pen') this.penAt = performance.now();
    if (this.drain !== null && e.pointerId === this.drain) {   // Excalidraw never saw this press
      e.stopImmediatePropagation();
      return;
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    e.stopImmediatePropagation();
    if (!(e.buttons & d.mask)) {       // drag button let go while another is held (no pointerup yet)
      this.finishDrag(e.buttons !== 0);
      return;
    }
    if (d.mode === 'press') {
      // Still a click until the pen moves past the threshold; then a pan that grabs the drawing
      // where it was pressed, so the first step catches up the distance already moved.
      if (Math.hypot(e.clientX - d.pressX, e.clientY - d.pressY) <= this.settings.penClickSlop) return;
      d.cam.startPan({ clientX: d.pressX, clientY: d.pressY });
      d.mode = 'pan';
      d.lastX = d.pressX;
      d.lastY = d.pressY;
      this.setDragCursor(d.target, 'pan');
    }
    // Pressing or releasing another button mid-drag only shows up as a change in e.buttons.
    if (d.chordable) {
      const want = e.buttons & 1 ? 'zoom' : 'pan';
      if (want !== d.mode) this.switchMode(d, want, e);
    }
    const [dx, dy] = this.moveDelta(d, e);
    if (d.mode === 'pan') {
      d.cam.panBy(dx, dy);
      if (dx || dy) d.moved = true;
    } else if (d.cam.dragMove(dy)) {
      d.moved = true;
    }
  };

  onPointerUp = e => {
    if (this.eatPenRightClick(e)) return;
    if (this.drain !== null && e.pointerId === this.drain) {   // last button of a chord let go
      e.preventDefault();
      e.stopImmediatePropagation();
      this.drain = null;
      const now = performance.now();
      this.clickUntil = this.dblUntil = now + SWALLOW_MS;
      if (this.penDragUntil === Infinity) this.penDragUntil = now + SWALLOW_MS;   // its menu follows the release
      return;
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.finishDrag(false);
  };

  // Middle-drag pan <-> hold-left zoom. Both pin the camera at the cursor, which while locked is
  // the press point under the cross, so switching never jumps and the zoom centres on the cross.
  switchMode(d, mode, e) {
    if (mode === 'zoom') { d.cam.endPan(); d.cam.startDrag(e); }
    else { d.cam.endDrag(); d.cam.startPan(e); }
    d.mode = mode;
    d.chorded = true;
    this.setDragCursor(d.target, mode);   // seen only if not locked
  }

  // End the drag. If another button is still held, keep swallowing that pointer until it's let go
  // too, so Excalidraw never sees half a click. A drag that moved or chorded also eats the click
  // that follows it (a plain Ctrl+middle-click with no movement still goes through).
  finishDrag(stillHeld) {
    const d = this.drag;
    if (!d) return;
    if (d.moved || d.chorded || d.pen) this.clickUntil = this.dblUntil = performance.now() + SWALLOW_MS;
    if (stillHeld) this.drain = d.pointerId;
    this.endDrag();
    if (d.mode === 'press' && d.cam.api) this.toggleTrayMenu(d.cam.api, d.root, d.pressX, d.pressY);   // a click
  }

  // A press outside the floating Edit menu closes it. On the drawing itself the press only closes
  // the menu, so dismissing it never leaves a stray mark (like Photoshop's and Procreate's brush
  // panels). Anywhere else (toolbars, other panes) it closes the menu and carries on as normal.
  closeFloatOnOutsidePress(e) {
    const f = this.float, t = e.target;
    if (!f || !f.el || !f.el.isConnected || !t || !t.closest || f.el.contains(t)) return false;
    // Not outside: the bar it belongs to (its Edit button toggles the menu itself), and pickers
    // the menu opened (Excalidraw marks those, or they're Radix popovers).
    if (t.closest('.App-bottom-bar, [data-prevent-outside-click], [data-radix-popper-content-wrapper]')) return false;
    if (f.api.isDestroyed) { this.stopFloat(false); return false; }
    if (f.api.getAppState().openPopup) return false;   // a picker is open: let Excalidraw close that first
    this.log('pen menu: closing (press outside it)');
    this.stopFloat(false);
    f.api.updateScene({ appState: { openMenu: null } });
    if (!isCanvas(t)) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.drain = e.pointerId;                          // eat the rest of this press
    if (e.pointerType === 'pen' && e.button === 2) this.penDragUntil = Infinity;   // and its right-click menu
    return true;
  }

  // The lock engages a moment after pointerdown, and Esc can drop it mid-drag. Show the stand-in
  // cursor only while the real one is actually hidden, so there's never a double cursor.
  onLockChange = () => {
    const d = this.drag;
    if (!d) return;
    d.skipNext = true;   // the first movement after the lock engages can be a bogus jump
    const doc = d.target.ownerDocument;
    const want = doc.pointerLockElement === d.target && d.showCross;   // stays on through hold-left zoom
    if (want && !d.standIn) d.standIn = this.makeStandIn(doc, d.pressX, d.pressY);
    else if (!want && d.standIn) { d.standIn.remove(); d.standIn = null; }
  };

  // The virtual cursor, pinned where you pressed, which is also where the real cursor comes back.
  makeStandIn(doc, x, y) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(NS, 'svg');
    const add = (tag, attrs) => {
      const el = doc.createElementNS(NS, tag);
      for (const k in attrs) el.setAttribute(k, String(attrs[k]));
      svg.appendChild(el);
      return el;
    };
    const type = PAN_CURSORS[this.settings.panCursorType] || PAN_CURSORS.cross;
    const g = type.draw(add, Math.max(4, Math.round(this.settings.panCursorSize)));
    svg.setAttribute('width', String(g.w));
    svg.setAttribute('height', String(g.h));
    svg.setAttribute('viewBox', g.viewBox || `0 0 ${g.w} ${g.h}`);
    if (g.icon) {
      for (const [k, v] of [['fill', 'none'], ['stroke', '#000'], ['stroke-width', '2'],
                            ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) svg.setAttribute(k, v);
    }
    svg.classList.add(CLS.panCursor);
    if (g.inverted) svg.classList.add(CLS.panCursorInverted);
    else if (g.icon) svg.classList.add(CLS.panCursorIcon);
    svg.style.left = `${x - g.hot[0]}px`;   // where you pressed
    svg.style.top = `${y - g.hot[1]}px`;
    doc.body.appendChild(svg);
    return svg;
  }

  // ─── B / P key swap ───
  // Catch B or P and hand Excalidraw the other key, so it handles it exactly like its own
  // shortcut: tool toggling, the bucket's colour cycling on a second press, view-mode rules.
  onKeyDown = e => {
    if (this.forwarding || !this.settings.swapPenBucketKeys) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing) return;
    const swapped = KEY_SWAP[(e.key || '').toLowerCase()];
    const t = e.target;
    if (!swapped || !t || isEditable(t) || !this.isExcalidrawKeyTarget(t)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const KE = (t.ownerDocument.defaultView || window).KeyboardEvent;
    const fake = new KE('keydown', {
      key: swapped, code: KEY_CODE[swapped], repeat: e.repeat,
      bubbles: true, cancelable: true, composed: true,
    });
    this.forwarding = true;   // our own listener sees the forwarded key too: let it through
    try { t.dispatchEvent(fake); } finally { this.forwarding = false; }
  };

  // Is this key headed for an Excalidraw drawing? Focus inside a view counts; keys typed with
  // nothing focused land on <body> and count only when an Excalidraw view is the active one.
  isExcalidrawKeyTarget(t) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view && leaf.view.containerEl.contains(t)) return true;
    }
    if (t === t.ownerDocument.body) {
      const v = this.app.workspace.getActiveViewOfType(ItemView);
      return !!v && v.getViewType() === VIEW_TYPE;
    }
    return false;
  }

  endDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.standIn) d.standIn.remove();
    d.cam.endPan();
    d.cam.endDrag();
    if (d.pen) this.penDragUntil = performance.now() + SWALLOW_MS;
    const doc = d.target.ownerDocument;
    if (doc.pointerLockElement === d.target) doc.exitPointerLock();
    try { d.target.releasePointerCapture(d.pointerId); } catch (_) {
      // Capture already gone (it ends by itself when the button comes up): nothing to release.
    }
    d.target.style.cursor = d.cursor;   // Excalidraw's own cursor back
  }

  // The cursor shown over the canvas while the plugin runs a drag (when it isn't locked and hidden).
  // `mode` is 'zoom' or 'pan'.
  setDragCursor(target, mode) {
    target.style.cursor = DRAG_CURSOR[mode];
  }

  // ─── Pen middle-button click: Tray mode's Edit menu at the pen ───
  viewAt(t) {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)
      .find(l => l.view && l.view.excalidrawAPI && l.view.containerEl.contains(t));
    return leaf ? leaf.view : null;
  }

  log(...args) {
    if (this.settings.debug) console.debug('[excalidraw-smooth-zoom]', ...args);
  }

  // Excalidraw's root element (the one carrying excalidraw--tray), found from what was pressed,
  // if this drawing is in Tray mode.
  trayRoot(view, target) {
    const api = view.excalidrawAPI;
    const root = (target.closest && target.closest('.excalidraw-container')) ||
                 view.containerEl.querySelector('.excalidraw-container');
    if (!api || api.isDestroyed || !root) { this.log('pen menu: no Excalidraw root found'); return null; }
    if (!root.classList.contains('excalidraw--tray')) {
      this.log('pen menu: this drawing is not in Tray mode (or is in view / zen mode)');
      return null;
    }
    return root;
  }

  // Tray mode's Edit button flips appState.openMenu between "shape" and closed. Do the same, but
  // float the menu next to the pen instead of leaving it in the bottom bar.
  toggleTrayMenu(api, root, x, y) {
    if (api.getAppState().openMenu === 'shape') {
      this.log('pen menu: closing');
      this.stopFloat(false);   // it's unmounting anyway; restoring the layout first would flash it
      api.updateScene({ appState: { openMenu: null } });
      return;
    }
    this.log('pen menu: opening at', x, y);
    api.updateScene({ appState: { openMenu: 'shape' } });
    this.floatTrayMenu(api, root, x, y);
  }

  floatTrayMenu(api, root, x, y) {
    this.stopFloat(true);
    const win = root.ownerDocument.defaultView || window;
    const f = { api, root, x, y, el: null, mo: null, ro: null };
    const fit = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    // Top-left beside the pen, kept inside the drawing. `position: fixed` normally resolves
    // against the window, but measuring the offset keeps it right if an ancestor changes that.
    const place = () => {
      const el = f.el;
      if (!el || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      const ox = r.left - (parseFloat(el.style.left) || 0);
      const oy = r.top - (parseFloat(el.style.top) || 0);
      const b = root.getBoundingClientRect();
      const left = fit(f.x + PEN_MENU_GAP, b.left + MENU_MARGIN, b.right - r.width - MENU_MARGIN);
      const top = fit(f.y + PEN_MENU_GAP, b.top + MENU_MARGIN, b.bottom - r.height - MENU_MARGIN);
      el.style.left = `${left - ox}px`;
      el.style.top = `${top - oy}px`;
    };
    // React mounts the menu on its next render, and may remount it. Float whichever is there.
    const check = () => {
      const el = root.querySelector('.App-tray-menu');
      if (el === f.el) return;
      if (f.ro) { f.ro.disconnect(); f.ro = null; }
      f.el = el;
      if (!el) {   // closed (stop), or hidden for now because the current tool has nothing to edit
        if (api.isDestroyed || api.getAppState().openMenu !== 'shape') this.stopFloat(false);
        return;
      }
      const width = el.getBoundingClientRect().width;   // its width in the bar, before lifting it out
      el.classList.add(CLS.float);   // starts at 0,0 (styles.css); place() moves it beside the pen
      el.style.width = `${width}px`;
      place();
      f.ro = new win.ResizeObserver(place);   // contents change with the tool: stay beside the pen
      f.ro.observe(el);
    };
    f.mo = new win.MutationObserver(check);
    f.mo.observe(root, { childList: true, subtree: true });
    this.float = f;
    // Nothing to show (e.g. selection tool, nothing selected): undo the open rather than leave it
    // pending, where it would pop up in the bottom bar later.
    win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
      if (this.float !== f) return;
      check();
      if (!f.el) {
        this.log('pen menu: Excalidraw showed no menu (nothing to edit with this tool and selection)');
        this.stopFloat(false);
        if (!api.isDestroyed) api.updateScene({ appState: { openMenu: null } });
      }
    }));
  }

  stopFloat(restore) {
    const f = this.float;
    if (!f) return;
    this.float = null;
    if (f.mo) f.mo.disconnect();
    if (f.ro) f.ro.disconnect();
    if (restore && f.el && f.el.isConnected) {
      f.el.classList.remove(CLS.float);
      for (const k of FLOAT_KEYS) f.el.style[k] = '';
    }
  }

  // Some pen drivers send the barrel button as an extra mouse right-click as well. During or just
  // after a pen drag, eat those presses and releases so Excalidraw never sees them.
  eatPenRightClick(e) {
    if (e.pointerType !== 'mouse' || e.button !== 2 || performance.now() >= this.penDragUntil) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    return true;
  }

  // Is this a context menu from the pen's barrel button, pressed with Ctrl to drag zoom?
  isPenZoomMenu(e) {
    const t = e.target;
    if (!e.ctrlKey || !this.settings.dragZoom || !t || !t.ownerDocument) return false;
    const penish = e.pointerType === 'pen' || performance.now() - this.penAt < PEN_RECENT_MS;
    return penish && this.app.workspace.getLeavesOfType(VIEW_TYPE)
      .some(l => l.view && l.view.containerEl.contains(t));
  }

  // Clicks belonging to a drag: anything during it, plus the stray click (or a double-click built
  // from it) just after.
  eatClick = e => {
    const now = performance.now();
    const until = e.type === 'dblclick' ? this.dblUntil : this.clickUntil;
    const menu = e.type === 'contextmenu' && (now < this.penDragUntil || this.isPenZoomMenu(e));
    if (e.type === 'contextmenu' && this.settings.debug) {
      console.debug('[excalidraw-smooth-zoom] contextmenu', {
        pointerType: e.pointerType, button: e.button, ctrl: e.ctrlKey,
        eaten: !!(menu || this.drag || this.drain !== null || now < until),
      });
    }
    if (!menu && !this.drag && this.drain === null && now >= until) return;
    if (e.type !== 'dblclick') this.clickUntil = 0;   // one stray click per drag
    e.preventDefault();
    e.stopImmediatePropagation();
  };
};

// ─── Settings ─────────────────────────────────────────────────────────────────
class SmoothZoomSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    const heading = name => new Setting(containerEl).setName(name).setHeading();
    const toggle = (name, desc, key) => new Setting(containerEl).setName(name).setDesc(desc)
      .addToggle(t => t.setValue(s[key]).onChange(v => { s[key] = v; save(); }));
    // Slider plus a number box for the same value. The slider covers the usual range; typing
    // accepts anything in [typedMin, typedMax] at full precision, even between slider steps.
    // `places`: show at least this many decimals in the box (1 -> "1.00"); finer typed values
    // are still shown in full, so the box never hides what's stored.
    const sliderWithInput = (name, desc, key, min, max, step, typedMin, typedMax, places = 0) => {
      const fmt = v => {
        const r = round6(v);
        const k = 10 ** places;
        return places && Math.abs(r * k - Math.round(r * k)) < 1e-9 ? r.toFixed(places) : String(r);
      };
      let slider, text, syncing = false;
      const set = (v, from) => {
        s[key] = v;
        save();
        syncing = true;   // don't let the components' own callbacks echo the update back
        try {
          if (from !== 'slider') slider.setValue(v);
          if (from !== 'text') text.setValue(fmt(v));
        } finally { syncing = false; }
      };
      new Setting(containerEl).setName(name).setDesc(desc)
        .addSlider(sl => {
          slider = sl;
          sl.setLimits(min, max, step).setValue(s[key]).setDynamicTooltip()
            .onChange(v => { if (!syncing) set(round6(v), 'slider'); });
        })
        .addText(t => {
          text = t;
          const el = t.inputEl;
          el.type = 'number';
          el.min = String(typedMin);
          el.max = String(typedMax);
          el.step = String(step);   // arrow keys nudge by one slider step
          el.classList.add(CLS.numberInput);
          t.setValue(fmt(s[key])).onChange(raw => {
            if (syncing) return;
            const v = parseFloat(raw);   // half-typed or out-of-range values wait for blur
            if (Number.isFinite(v) && v >= typedMin && v <= typedMax) set(v, 'text');
          });
          // Leaving the box (or Enter) settles it: clamp out-of-range, restore if not a number.
          el.addEventListener('blur', () => {
            const v = parseFloat(el.value);
            if (Number.isFinite(v)) set(clamp(v, typedMin, typedMax));
            else text.setValue(fmt(s[key]));
          });
          el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
        })
        .addExtraButton(b => b.setIcon('rotate-ccw').setTooltip(`Reset to ${DEFAULTS[key]}`)
          .onClick(() => set(DEFAULTS[key])));
    };

    heading('Wheel zoom');
    toggle('Plain wheel zooms',
      'Scroll with no modifier to zoom. Off: only Ctrl+wheel and pinch use the smooth zoom, and the plain wheel pans as normal.',
      'plainWheelZooms');
    sliderWithInput('Zoom speed',
      'How far each wheel notch zooms. 1.00 is the default; 2.00 zooms twice as far per notch. Type any value from 0.1 to 50.',
      'zoomSpeed', 0.1, 1.9, 0.01, 0.1, 50, 2);   // default 1.00 sits mid-slider
    sliderWithInput('Smoothing (ms)',
      'Wheel zoom easing. Lower is snappier, higher is floatier. Fast spins automatically tighten to about a third of this, following how quickly the ticks come. Type any value from 0 to 1000.',
      'smoothingMs', 0, 250, 1, 0, 1000);
    sliderWithInput('Wheel bounce guard (ms)',
      'Many mouse wheels report the odd tick in the wrong direction when spun fast, which jolts the zoom. A reverse tick this soon after the last tick is ignored. 0 turns it off. Type any value from 0 to 1000.',
      'wheelBounceMs', 0, 300, 5, 0, 1000);

    heading('Middle-drag pan');
    toggle('Captive cursor',
      'Lock and hide the cursor while panning so it never leaves the canvas. It comes back where you pressed. Off: the cursor moves freely.',
      'captivePan');
    toggle('Show cursor while panning',
      'Shows a virtual cross cursor while panning. Recommended to keep enabled at first to help build up your muscle memory.',
      'panShowCursor');
    new Setting(containerEl).setName('Panning cursor type')
      .setDesc('What the virtual cursor looks like. Inverted shapes flip the colours beneath them; the others have an outline so they show on any background.')
      .addDropdown(dd => {
        for (const [key, t] of Object.entries(PAN_CURSORS)) dd.addOption(key, t.label);
        dd.setValue(s.panCursorType in PAN_CURSORS ? s.panCursorType : DEFAULTS.panCursorType)
          .onChange(v => { s.panCursorType = v; save(); });
      });
    sliderWithInput('Panning cursor size (px)',
      'Size of the virtual cursor shown while panning. The lines of the inverted shapes thicken with it. Type any value from 4 to 200.',
      'panCursorSize', 8, 64, 1, 4, 200);
    sliderWithInput('Pan speed',
      '1 keeps the canvas glued to your hand. Adjust if display scaling makes the locked pan run fast or slow. Type any value from 0.05 to 10.',
      'panSpeed', 0.25, 3, 0.01, 0.05, 10);
    toggle('Hold left click to zoom',
      'While middle-drag panning, also hold the left button and drag up or down to zoom around the press point, using the Ctrl + middle-drag zoom settings below. Let go of the left button to go back to panning.',
      'chordZoom');

    heading('Ctrl + middle-drag zoom');
    toggle('Enabled',
      'Hold Ctrl, press the middle button and drag up or down. With a pen, hold Ctrl and drag with the tip, or with a side button pressed (while hovering or before the tip touches).',
      'dragZoom');
    sliderWithInput('Drag zoom speed',
      'Zoom per pixel of vertical movement. 100 px at 0.01 is about 2.7x. Type any value from 0.0001 to 0.1.',
      'dragZoomSpeed', 0.001, 0.03, 0.0001, 0.0001, 0.1);
    toggle('Drag up zooms in', 'Off: drag down to zoom in.', 'dragZoomUpZoomsIn');
    sliderWithInput('Drag smoothing (ms)',
      '0 makes the zoom track the mouse instantly. Type any value from 0 to 500.',
      'dragZoomSmoothingMs', 0, 50, 0.05, 0, 500);
    toggle('Captive cursor',
      'Lock and hide the cursor while drag zooming so it never hits the screen edge, like Blender. Mouse only.',
      'dragZoomInfinite');

    heading('Pen');
    toggle('Side button opens the Edit menu',
      "In Tray mode, clicking the pen's right-click side button opens the Edit menu (the shape properties: stroke, background, stroke width, pressure, opacity) next to the pen, instead of the right-click menu. Dragging with it pans the drawing. Click it again, or anywhere outside the menu, to close it. Ctrl + side button is still the drag zoom.",
      'penMenu');
    sliderWithInput('Side button click threshold (px)',
      'Move the pen less than this between pressing and letting go of the side button and it counts as a click (Edit menu); move further and it pans instead. Type any value from 1 to 100.',
      'penClickSlop', 2, 40, 1, 1, 100);

    heading('Tool shortcuts');
    toggle('Pen on B, paint bucket on P',
      "I'm used to photoshop keybinds, so this is a lazy fix for me so I don't have to change my muscle memory. Probably better to keep this disabled.",
      'swapPenBucketKeys');

    heading('Debug');
    toggle('Log input events',
      "Print wheel events and pointer presses to the developer console (Ctrl+Shift+I; set its level filter to include Verbose). Useful for tuning zoom speed, or checking what a pen's buttons send.",
      'debug');
  }
}
