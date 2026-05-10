import React, { createRef } from "react";
import { createRoot } from "react-dom/client";
import TableWidget from "../components/TableWidget/TableWidget";
import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.css";

class TableWidgetElement extends HTMLElement {
  constructor() {
    super();
    this._root = null;
    this._mount = null;
    this._widgetRef = createRef();
    this._pendingOpen = false;
  }

  connectedCallback() {
    this._mount = document.createElement("div");
    this.appendChild(this._mount);
    this._root = createRoot(this._mount);
    this._render();
  }

  disconnectedCallback() {
    this._root?.unmount();
    this._root = null;
    this._mount = null;
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
    return ["tabs", "api-url", "title", "label", "button-variant", "manual"];
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

    this._root.render(
      React.createElement(TableWidget, {
        ref: this._widgetRef,
        tabs,
        apiBase,
        title,
        label,
        buttonVariant,
        manual,
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