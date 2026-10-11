/**
 * ERNAS ENGINE — tests/_fakedom.js
 * =====================================================================
 *  Just enough of the DOM for src/main.js to load and run in Node.
 * =====================================================================
 *
 * Not a DOM.  No layout, no events beyond a manual dispatch, no styles.  It
 * exists so `tests/main_headless.test.js` can drive the real frame loop in
 * main.js instead of a re-implementation of it — a re-implementation would
 * test the re-implementation.
 */

class FakeClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { for (const x of c) this.set.add(x); this._sync(); }
  remove(...c) { for (const x of c) this.set.delete(x); this._sync(); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    this._sync();
    return on;
  }
  _sync() { this.el.className = [...this.set].join(" "); }
}

const TAG_RE = /<(\w+)((?:\s+[^>]*?)?)>([\s\S]*?)<\/\1>/g;

export class FakeElement {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.className = "";
    this.classList = new FakeClassList(this);
    this.style = {};
    this.disabled = false;
    this.textContent = "";
    this._html = "";
    this.listeners = new Map();
    this.width = 0;
    this.height = 0;
    this._gl = null;
  }

  /**
   * main.js builds its HUD rows with
   *   el.innerHTML = `<span class="k">label</span><span class="v" id=".."></span>`
   * and then does `el.querySelector(".v")`.  So the stub has to turn that
   * string into real child nodes; merely storing it (as it did first) leaves the
   * rows childless and every HUD assertion reads undefined.
   *
   * This parses only that shape — a flat run of `<tag class=".." id="..">text</tag>`.
   * It is not an HTML parser and must not be used as one.
   */
  set innerHTML(v) {
    this._html = v;
    this.children = [];
    TAG_RE.lastIndex = 0;
    let m;
    while ((m = TAG_RE.exec(v))) {
      const [, tag, attrs, text] = m;
      const el = new FakeElement(tag);
      el.textContent = text;
      const cls = /class="([^"]*)"/.exec(attrs);
      const id = /id="([^"]*)"/.exec(attrs);
      if (cls) el.classList.add(...cls[1].split(/\s+/).filter(Boolean));
      if (id) el.id = id[1];
      this.children.push(el);
    }
  }
  get innerHTML() { return this._html; }

  appendChild(child) { this.children.push(child); return child; }

  /** Supports exactly the `.className` form main.js uses. */
  querySelector(sel) {
    if (sel.startsWith(".")) {
      return this.children.find((c) => c.classList.contains(sel.slice(1))) ?? null;
    }
    if (sel.startsWith("#")) {
      return this.children.find((c) => c.id === sel.slice(1)) ?? null;
    }
    return this.children.find((c) => c.tagName === sel.toUpperCase()) ?? null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener() {}
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  requestPointerLock() { /* pointer lock cannot exist headlessly */ }
  getContext(kind) {
    if (kind !== "webgl2") return null;
    return this._gl;
  }
}

/**
 * Install the globals main.js expects.
 * @param {FakeElement} canvas the element `getContext("webgl2")` is called on
 * @returns {{elements: Map<string, FakeElement>, rafQueue: Function[]}}
 */
export function installDom(canvas) {
  const elements = new Map();
  elements.set("gl", canvas);
  for (const id of ["overlay", "overlay-body", "hud", "boot", "cross"]) {
    elements.set(id, new FakeElement(id === "boot" ? "button" : "div", id));
  }

  const rafQueue = [];

  /*
   * `document` and `window` are FakeElements too, not plain objects: main.js
   * registers keydown/mousemove on document and resize/blur on window, and the
   * test needs to fire those through the same path a browser would.  The extra
   * properties they carry are bolted on below.
   */
  const doc = new FakeElement("document", "#document");
  doc.getElementById = (id) => elements.get(id) ?? null;
  doc.createElement = (tag) => new FakeElement(tag);
  doc.pointerLockElement = null;

  const win = new FakeElement("window", "#window");
  win.innerWidth = 1280;
  win.innerHeight = 800;
  win.devicePixelRatio = 1;

  globalThis.document = doc;
  globalThis.window = win;
  globalThis.location = { search: "" };
  globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };

  return { elements, rafQueue };
}

/** Remove the globals, so test files do not leak into each other. */
export function uninstallDom() {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.location;
  delete globalThis.requestAnimationFrame;
}
