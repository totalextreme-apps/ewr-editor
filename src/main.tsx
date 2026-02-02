import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// IMPORTANT: load theme globally here
import "./styles/ewrTheme.css";

// Platform hook: WebView2 on Windows can render <select> dropdown menus
// with white text on a white menu background unless we apply platform-specific
// option colors in CSS.
try {
  const ua = (navigator.userAgent || "").toLowerCase();
  if (ua.includes("windows")) {
    document.documentElement.classList.add("platform-windows");
  }
} catch {
  // no-op
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
