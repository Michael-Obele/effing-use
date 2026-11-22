/**
 * The one script that runs inside the WebView.
 *
 * Deliberate choices:
 * - A single injected runtime (`window.__effing`) instead of a new expression
 *   per call: with `Page.addScriptToEvaluateOnNewDocument` it survives reloads,
 *   and every action costs one small CDP round trip.
 * - Shadow DOM is pierced only for the native control. Ionic's `ion-input`
 *   renders the real `<input>` in a shadow root; clicking the host by
 *   coordinates works, but `fill` must reach the native control or the value
 *   never lands in the app's state.
 * - Refs are indices into a per-snapshot array on the page. Elements are
 *   checked with `isConnected` at act time, so a re-render produces E_STALE
 *   instead of a click on a detached node.
 * - No template literals: this string is assembled in TypeScript, so `${}` in
 *   the page script would be interpolated here by accident.
 */
/** An IIFE that installs the runtime and returns "ready". */
export const RUNTIME = String.raw`
(() => {
  var W = window;
  if (W.__effing) { try { W.__effing.hook(); } catch (e) {} return "ready"; }

  var SEL = [
    "a[href]", "button", "input", "select", "textarea", "summary",
    "ion-button", "ion-item", "ion-input", "ion-textarea", "ion-searchbar",
    "ion-select", "ion-toggle", "ion-checkbox", "ion-radio", "ion-tab-button",
    "ion-fab-button", "ion-menu-button", "ion-back-button", "ion-chip",
    "ion-segment-button", "ion-datetime-button", "ion-router-link",
    "[contenteditable=''],[contenteditable=true]",
    "[role=button]", "[role=link]", "[role=tab]", "[role=checkbox]",
    "[role=switch]", "[role=menuitem]", "[role=option]", "[role=textbox]",
    "[role=searchbox]", "[role=combobox]", "[role=radio]", "[role=slider]",
    "[role=spinbutton]"
  ].join(",");

  var state = {
    refs: [],
    plugins: [],
    hooked: false,
    errors: 0
  };
  W.__effingState = state;

  function visible(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (cs.opacity !== "" && Number(cs.opacity) === 0) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    return true;
  }

  // The native control behind a web component, if any. Value-bearing elements
  // only: a shadow <button> inside ion-button would duplicate the host.
  function nativeControl(host) {
    var sr = host.shadowRoot;
    if (!sr) return null;
    var inner = sr.querySelector("input:not([type=hidden]),textarea,select");
    if (inner && typeof inner.value === "string") return inner;
    return null;
  }

  function candidate(el) {
    try { if (el.matches && el.matches(SEL)) return true; } catch (e) {}
    // Any custom element wrapping a control counts, even if its tag is unknown
    // to us: Capacitor apps are built from Ionic/Stencil/Shoelace components
    // whose real input lives in a shadow root.
    return !!nativeControl(el);
  }

  /**
   * Document-order walk that descends into open shadow roots. Nodes inside a
   * shadow root are never refs of their own — the host is, because that is what
   * a tap has to hit and what the app's own listeners watch.
   */
  function collect() {
    var out = [];
    function visit(root, inShadow) {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      var node = walker.nextNode();
      while (node) {
        if (!inShadow && candidate(node)) out.push(node);
        if (node.shadowRoot) visit(node.shadowRoot, true);
        node = walker.nextNode();
      }
    }
    visit(document, false);
    return out;
  }

  function label(el) {
    // Deliberately not el.value: a filled input would then rename itself on
    // every keystroke and a delta would report the app changing when only the
    // text did. The fill response echoes the value; the snapshot stays stable.
    var raw =
      (el.innerText || "").trim() ||
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      (el.labels && el.labels[0] && el.labels[0].innerText) ||
      el.getAttribute("title") ||
      "";
    return String(raw).replace(/\s+/g, " ").trim().slice(0, 60);
  }

  function describe(host) {
    // Ionic puts the label on the host, plain custom elements put it on the
    // shadow control; use whichever carries it so the line is never empty.
    var ctl = nativeControl(host);
    var el = ctl && !(host.innerText || "").trim() ? ctl : host;
    var tag = host.tagName.toLowerCase();
    var parts = [];
    var aria = el.getAttribute("aria-label");
    if (aria) parts.push('aria="' + aria.slice(0, 40) + '"');
    var nm = el.getAttribute("name");
    if (nm) parts.push("name=" + nm);
    var id = el.getAttribute("id");
    if (id) parts.push("#" + id);
    var type = el.getAttribute("type");
    if (type) parts.push(type);
    var ph = el.getAttribute("placeholder");
    if (ph) parts.push('ph="' + ph.slice(0, 30) + '"');
    var flags = [];
    if (el.checked || host.getAttribute("aria-checked") === "true") flags.push("checked");
    if (el.disabled || host.getAttribute("aria-disabled") === "true") flags.push("disabled");
    if (el.required) flags.push("required");
    return tag + ' "' + label(el) + '"' +
      (parts.length ? " " + parts.join(" ") : "") +
      (flags.length ? " [" + flags.join(",") + "]" : "");
  }

  function snapshot(opts) {
    opts = opts || {};
    var max = opts.max || 150;
    var refs = [];
    var cands = collect();
    for (var i = 0; i < cands.length; i++) {
      var host = cands[i];
      // Visibility is a property of the element the user sees, so test the
      // host: the inner control of an ion-toggle is transparent by design.
      if (!visible(host)) continue;
      refs.push({ el: nativeControl(host) || host, host: host });
      if (refs.length >= max) break;
    }
    state.refs = refs;
    var lines = [];
    for (var j = 0; j < refs.length; j++) {
      lines.push("[e" + j + "] " + describe(refs[j].host));
    }
    return {
      url: location.href,
      title: document.title,
      count: refs.length,
      lines: lines.join("\n")
    };
  }

  function ref(i) {
    var r = state.refs[i];
    if (!r || !r.host.isConnected || !r.el.isConnected) return null;
    return r;
  }

  function box(i) {
    var r = ref(i);
    if (!r) return { stale: true };
    try { r.host.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
    var b = r.host.getBoundingClientRect();
    var x = Math.round(b.left + b.width / 2);
    var y = Math.round(b.top + b.height / 2);
    // Hit test before the tap: a toast, a loading overlay or a sticky header
    // will swallow the touch, and the agent would see "tap ok" plus an
    // unexplained lack of change.
    var out = { x: x, y: y, w: Math.round(b.width), h: Math.round(b.height), tag: r.host.tagName.toLowerCase(), hit: true };
    try {
      var top = document.elementFromPoint(x, y);
      if (top && top !== r.el && top !== r.host && !r.host.contains(top) && !r.el.contains(top)) {
        out.hit = false;
        out.coveredBy = top.tagName.toLowerCase() + (top.id ? "#" + top.id : "");
      }
    } catch (e) {}
    return out;
  }

  function domBox(sel) {
    var el;
    try { el = document.querySelector(sel); } catch (e) { return { badSelector: String(e && e.message || e) }; }
    if (!el) return { notFound: true };
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
    var b = el.getBoundingClientRect();
    return {
      x: Math.round(b.left + b.width / 2),
      y: Math.round(b.top + b.height / 2),
      w: Math.round(b.width),
      h: Math.round(b.height),
      tag: el.tagName.toLowerCase()
    };
  }

  function fire(el, type) {
    // composed: true is what a real keystroke does. Without it the event stops
    // at the shadow boundary and an app listening on document never sees the
    // change (verified against Chrome: the fill "worked" but nobody knew).
    el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }

  function fill(i, value) {
    var r = ref(i);
    if (!r) return { stale: true };
    var el = r.el;
    if (el.isContentEditable) {
      el.focus();
      el.textContent = value;
      fire(el, "input");
      fire(el, "change");
      return { ok: true, value: el.textContent };
    }
    try { el.focus(); } catch (e) {}
    var proto =
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype :
      el.tagName === "SELECT" ? HTMLSelectElement.prototype :
      HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    // The native setter bypasses React/Vue's value tracker, then the events
    // tell the framework a user typed: the only reliable way to fill a
    // controlled input from outside.
    if (desc && desc.set) desc.set.call(el, String(value));
    else el.value = String(value);
    fire(el, "input");
    fire(el, "change");
    return { ok: true, value: el.value };
  }

  function focusBox(i) {
    var r = ref(i);
    if (!r) return { stale: true };
    try { r.el.focus(); } catch (e) {}
    return box(i);
  }

  function text(cap) {
    var body = document.body ? document.body.innerText : "";
    return { text: String(body || "").slice(0, cap || 20000) };
  }

  function html(cap) {
    return { html: document.documentElement.outerHTML.slice(0, cap || 20000) };
  }

  function table(sel) {
    var t;
    try { t = document.querySelector(sel || "table"); } catch (e) { return { badSelector: String(e) }; }
    if (!t) return { notFound: true };
    var rows = [].map.call(t.querySelectorAll("tr"), function (tr) {
      return [].map.call(tr.querySelectorAll("th,td"), function (c) {
        return (c.innerText || "").trim();
      });
    });
    return { rows: rows };
  }

  function query(sel) {
    var els;
    try { els = document.querySelectorAll(sel); } catch (e) { return { badSelector: String(e && e.message || e) }; }
    var out = [];
    for (var i = 0; i < els.length && out.length < 100; i++) {
      var el = els[i];
      out.push({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200),
        href: el.getAttribute("href") || undefined,
        value: typeof el.value === "string" ? el.value : undefined
      });
    }
    return { count: els.length, items: out };
  }

  // A cheap fingerprint of what the user would see, used only to decide that the
  // DOM has stopped moving after an input. Text length plus control count is
  // enough to notice an overlay mounting, a list filtering, or a route swap,
  // and it costs one string compare per poll instead of a full snapshot.
  function sig() {
    var body = document.body;
    var visible = 0;
    var els = document.querySelectorAll(SEL);
    for (var i = 0; i < els.length; i++) {
      if (visibleEl(els[i])) visible++;
    }
    return (
      location.href +
      "|" +
      (body ? body.innerText.length : 0) +
      "|" +
      els.length +
      "|" +
      visible +
      "|" +
      document.title
    );
  }

  // Containment check without the layout work visible() does for snapshots:
  // only used by sig(), where parent-chain truth is enough.
  function visibleEl(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function scrollable(el, axis) {
    var node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      var cs = getComputedStyle(node);
      var sx = (cs.overflowX === "auto" || cs.overflowX === "scroll") && node.scrollWidth > node.clientWidth + 1;
      var sy = (cs.overflowY === "auto" || cs.overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1;
      if ((axis === "x" && sx) || (axis === "y" && sy) || (axis === "both" && (sx || sy))) return node;
      node = node.parentElement;
    }
    return null;
  }

  function nameOf(el) {
    if (!el || el === document.documentElement || el === document.body) return "document";
    return (
      el.tagName.toLowerCase() +
      (el.id ? "#" + el.id : "") +
      (el.className && typeof el.className === "string"
        ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "")
    );
  }

  /**
   * Where a scroll would go, and where it already is.
   *
   * Resolves a ref, a CSS selector, or the viewport centre to a point, finds the
   * nearest scrollable ancestor for the requested axis, and reports the scroll
   * position plus the maximum. The host dispatches the gesture and calls this
   * again to prove something moved: a scroll that silently does nothing is the
   * same lie as a tap that reports ok and changes nothing.
   */
  function scrollProbe(target, axis) {
    axis = axis === "x" ? "x" : "y";
    var el = null;
    if (typeof target === "number") {
      var r = ref(target);
      if (!r) return { stale: true };
      el = r.host;
    } else if (typeof target === "string" && target) {
      try {
        el = document.querySelector(target);
      } catch (e) {
        return { badSelector: String(e && e.message || e) };
      }
      if (!el) return { notFound: true };
    } else {
      el = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
    }
    if (!el) return { notFound: true };

    var scroller = scrollable(el, axis);
    var box = el.getBoundingClientRect();
    var point = { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    // Keep the point on screen: an element scrolled off-screen has an
    // off-viewport centre, and a gesture there goes nowhere.
    point.x = Math.max(1, Math.min(point.x, innerWidth - 2));
    point.y = Math.max(1, Math.min(point.y, innerHeight - 2));
    // ...and inside the scroll region itself. At the end of a horizontal
    // scroller the centred element sits past the right edge, so the clamped
    // point lands in the page margin and the gesture bubbles past the scroller
    // (measured: scrollLeft stuck at max while a "successful" scroll was
    // reported). Intersect with the scroller's own visible box instead.
    if (scroller) {
      var sb = scroller.getBoundingClientRect();
      var left = Math.max(sb.left, 0) + 4;
      var right = Math.min(sb.right, innerWidth) - 4;
      var top = Math.max(sb.top, 0) + 4;
      var bottom = Math.min(sb.bottom, innerHeight) - 4;
      if (right > left) point.x = Math.round((left + right) / 2);
      if (bottom > top) point.y = Math.round((top + bottom) / 2);
    }

    var doc = document.scrollingElement || document.documentElement;
    var s = scroller || doc;
    var maxLeft = Math.max(0, s.scrollWidth - s.clientWidth);
    var maxTop = Math.max(0, s.scrollHeight - s.clientHeight);
    return {
      point: point,
      scroller: scroller ? nameOf(scroller) : "document",
      isDocument: !scroller,
      left: Math.round(s.scrollLeft),
      top: Math.round(s.scrollTop),
      maxLeft: maxLeft,
      maxTop: maxTop,
      viewport: { w: innerWidth, h: innerHeight }
    };
  }

  function stateOf() {
    var C = W.Capacitor;
    var http = false;
    try {
      if (W.CapacitorNativeConfig) http = W.CapacitorNativeConfig.httpEnabled === true;
      else if (W.CapacitorHttpAndroidInterface) http = W.CapacitorHttpAndroidInterface.isEnabled() === true;
    } catch (e) {}
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      platform: C && C.getPlatform ? C.getPlatform() : "unknown",
      capacitor: !!C,
      plugins: C && C.Plugins ? Object.keys(C.Plugins) : [],
      capacitorHttp: http,
      refs: state.refs.length
    };
  }

  function redact(v) {
    if (v === null || typeof v !== "object") {
      return typeof v === "string" ? v.slice(0, 120) : v;
    }
    var out = {};
    for (var k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (/pass|secret|token|otp|pin|auth|key/i.test(k)) { out[k] = "[redacted]"; continue; }
      var val = v[k];
      out[k] = typeof val === "string" ? val.slice(0, 120)
        : val && typeof val === "object" ? "[object]" : val;
    }
    return out;
  }

  function trim(arr, n) { if (arr.length > n) arr.splice(0, arr.length - n); }

  // Every Capacitor plugin call funnels through cap.toNative();
  // cap.fromNative() answers with the matching callbackId. Hooking the pair is
  // what turns "the camera failed" into plugin + method + args + duration.
  function hook() {
    var C = W.Capacitor;
    if (!C || C.__effingHooked || typeof C.toNative !== "function") return false;
    C.__effingHooked = true;
    var toNative = C.toNative;
    var fromNative = C.fromNative;
    C.toNative = function (pluginName, methodName, options) {
      var id = toNative.apply(this, arguments);
      try {
        state.plugins.push({
          plugin: String(pluginName),
          method: String(methodName),
          callbackId: id,
          args: redact(options),
          at: Date.now()
        });
        trim(state.plugins, 80);
      } catch (e) {}
      return id;
    };
    C.fromNative = function (result) {
      try {
        if (result && result.callbackId != null) {
          for (var i = state.plugins.length - 1; i >= 0; i--) {
            var p = state.plugins[i];
            if (p.callbackId === result.callbackId && p.ms === undefined) {
              p.ok = result.success !== false;
              p.ms = Date.now() - p.at;
              if (result.success === false) {
                p.error = String((result.error && result.error.message) || result.error || "").slice(0, 200);
              }
              break;
            }
          }
        }
      } catch (e) {}
      return fromNative ? fromNative.apply(this, arguments) : undefined;
    };
    return true;
  }

  function plugins() {
    return { hooked: state.hooked || !!W.Capacitor && !!W.Capacitor.__effingHooked, calls: state.plugins.slice(-50) };
  }

  state.hooked = hook();
  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    if (hook() || tries > 50) clearInterval(timer);
  }, 200);
  W.addEventListener("error", function () { state.errors += 1; });
  W.addEventListener("unhandledrejection", function () { state.errors += 1; });

  W.__effing = {
    snapshot: snapshot,
    box: box,
    domBox: domBox,
    focusBox: focusBox,
    fill: fill,
    text: text,
    html: html,
    table: table,
    query: query,
    state: stateOf,
    plugins: plugins,
    hook: hook,
    sig: sig,
    scrollProbe: scrollProbe
  };
  return "ready";
})()
`;
