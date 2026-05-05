import React from "react";
import { createRoot } from "react-dom/client";
import TableWidget from "../components/TableWidget/TableWidget";
import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.css";

class TableWidgetElement extends HTMLElement {
  constructor() {
    super();
    this._root = null;
    this._mount = null;
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

  static get observedAttributes() {
    return ["tabs", "api-url", "title", "label", "button-variant"];
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

    this._root.render(
      React.createElement(TableWidget, { tabs, apiBase, title, label, buttonVariant })
    );
  }
}

if (!customElements.get("table-widget")) {
  customElements.define("table-widget", TableWidgetElement);
}
