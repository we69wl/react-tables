/**
 * table-widget-loader.iife.js
 *
 * Tiny lazy-loader (~1 KB) for the main table-widget bundle (~1.5 MB).
 * Enqueue ONLY this file in WordPress — the heavy bundle loads on first click.
 *
 * Usage in PHP:
 *   <!-- Hidden widget instance (no button rendered) -->
 *   <table-widget id="my-widget" manual="true" api-url="..." title="..." tabs='[...]'></table-widget>
 *
 *   <!-- Any clickable element that triggers this widget -->
 *   <button class="js-open-table-widget" data-widget-id="my-widget">Открыть таблицу</button>
 *
 * The loader auto-detects the main bundle URL from its own <script src>.
 * Override via: window.TableWidgetLoaderConfig = { bundleUrl: '/path/to/table-widget.iife.js' }
 */
(function() {
    "use strict";

    // Capture currentScript synchronously (unavailable inside callbacks)
    var loaderSrc = (document.currentScript && document.currentScript.src) || "";

    // Derive main bundle URL: same directory, swap filename
    var BUNDLE_URL =
        (window.TableWidgetLoaderConfig && window.TableWidgetLoaderConfig.bundleUrl) ||
        (loaderSrc ?
            loaderSrc.replace("table-widget-loader.iife.js", "table-widget.iife.js") :
            "/table-widget.iife.js");

    var state = "idle"; // "idle" | "loading" | "loaded"
    var queue = [];

    function loadBundle(callback) {
        if (state === "loaded") {
            callback();
            return;
        }

        queue.push(callback);

        if (state === "loading") return;
        state = "loading";

        var script = document.createElement("script");
        script.src = BUNDLE_URL;
        script.async = true;

        script.onload = function() {
            state = "loaded";
            var pending = queue.slice();
            queue = [];
            pending.forEach(function(fn) {
                fn();
            });
        };

        script.onerror = function() {
            console.error("[table-widget-loader] Failed to load bundle:", BUNDLE_URL);
            state = "idle"; // allow retry on next click
            queue = [];
        };

        document.head.appendChild(script);
    }

    function openWidget(widgetId) {
        var el = document.getElementById(widgetId);
        if (!el) {
            console.warn("[table-widget-loader] Element not found:", widgetId);
            return;
        }

        // Wait for the custom element class to be registered, then open
        customElements.whenDefined("table-widget").then(function() {
            // Give React one frame to commit its first render before calling open()
            requestAnimationFrame(function() {
                if (typeof el.open === "function") {
                    el.open();
                } else {
                    console.warn("[table-widget-loader] .open() not available on element:", widgetId);
                }
            });
        });
    }

    // Event delegation — works for elements added to DOM after this script runs
    document.addEventListener("click", function(e) {
        var trigger = e.target.closest(".js-open-table-widget");
        if (!trigger) return;

        e.preventDefault();

        var widgetId = trigger.getAttribute("data-widget-id");
        if (!widgetId) {
            console.warn("[table-widget-loader] Trigger is missing data-widget-id attribute:", trigger);
            return;
        }

        loadBundle(function() {
            openWidget(widgetId);
        });
    });
})();