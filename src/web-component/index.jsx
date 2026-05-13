import React, { createRef } from "react";
import { createRoot } from "react-dom/client";
import TableWidget from "../components/TableWidget/TableWidget";
import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.css";

// Constructable Stylesheet shared across all instances — one CSS object in memory
// regardless of how many <table-widget> elements are on the page.
let _sharedSheet = null;
let _fontsInjected = false;

// @font-face in adoptedStyleSheets is unreliable across browsers.
// Fonts are a global resource — injecting them once into document.head is safe
// and doesn't affect host page layout or styles.
function injectFontsGlobally(css) {
  if (_fontsInjected || document.getElementById("__tw-fonts__")) return;
  _fontsInjected = true;
  const fontFaces = [];
  const re = /@font-face\s*\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(css)) !== null) fontFaces.push(m[0]);
  if (!fontFaces.length) return;
  const style = document.createElement("style");
  style.id = "__tw-fonts__";
  style.textContent = fontFaces.join("\n");
  document.head.appendChild(style);
}

function getSharedSheet() {
  if (!_sharedSheet) {
    // :root in shadow adoptedStyleSheets matches nothing — remap to :host so
    // Bootstrap variables and base styles land on the shadow host element and
    // inherit into the shadow tree normally.
    const css = (window.__TABLE_WIDGET_CSS__ || "").replace(/:root\b/g, ":host");
    injectFontsGlobally(css);
    _sharedSheet = new CSSStyleSheet();
    _sharedSheet.replaceSync(css);
  }
  return _sharedSheet;
}

class TableWidgetElement extends HTMLElement {
  constructor() {
    super();
    this._root = null;
    this._mount = null;
    this._portalMount = null;
    this._shadow = null;
    this._widgetRef = createRef();
    this._pendingOpen = false;
  }

  connectedCallback() {
    this._shadow = this.attachShadow({ mode: "open" });

    // Share one CSSStyleSheet object across all instances (memory efficient)
    this._shadow.adoptedStyleSheets = [getSharedSheet()];

    // Modal portal target — Bootstrap Modal renders here instead of document.body,
    // keeping all widget styles inside the shadow root.
    this._portalMount = document.createElement("div");
    this._shadow.appendChild(this._portalMount);

    // React mount point for the button / trigger
    this._mount = document.createElement("div");
    this._shadow.appendChild(this._mount);

    this._root = createRoot(this._mount);
    this._render();
  }

  disconnectedCallback() {
    this._root?.unmount();
    this._root = null;
    this._mount = null;
    this._portalMount = null;
    this._shadow = null;
  }

  // Public API: called by the loader script to open the modal
  open() {
    if (this._widgetRef.current) {
      this._widgetRef.current.open();
    } else {
      // React hasn't committed yet — open as soon as onReady fires
      this._pendingOpen = true;
    }
  }

  static get observedAttributes() {
    return ["tabs", "api-url", "title", "label", "button-variant", "manual", "notice-text"];
  }

  attributeChangedCallback() {
    if (this._root) this._render();
  }

  _render() {
    const tabs = JSON.parse(this.getAttribute("tabs") || "[]");
    const apiBase = this.getAttribute("api-url") || "/api";
    const title = this.getAttribute("title") || "Таблица";
    const label = this.getAttribute("label") || "Открыть";
    const buttonVariant = this.getAttribute("button-variant") || "primary";
    const manual = this.getAttribute("manual") === "true";
    const noticeText = this.getAttribute("notice-text") ?? undefined; // undefined → use TableWidget default

    this._root.render(
      React.createElement(TableWidget, {
        ref: this._widgetRef,
        tabs,
        apiBase,
        title,
        label,
        buttonVariant,
        manual,
        noticeText,
        portalContainer: this._portalMount,
        onReady: () => {
          if (this._pendingOpen) {
            this._pendingOpen = false;
            this._widgetRef.current?.open();
          }
        },
      })
    );
  }
}

if (!customElements.get("table-widget")) {
  customElements.define("table-widget", TableWidgetElement);
}
