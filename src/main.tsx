import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// IMPORTANT: load theme globally here
import "./styles/ewrTheme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
