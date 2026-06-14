import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root element #root not found");
// Wrap the root render so a render-time crash shows a recoverable fallback
// instead of a blank page. The federated PluginConfigurationPanel export
// wraps itself internally (see components/PluginConfigurationPanel.tsx).
createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
