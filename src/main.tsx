import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./styles.css";
import { installPlatformGeometry } from "./lib/platformGeometry";

installPlatformGeometry();
registerSW({ immediate: true });

createRoot(document.getElementById("root")!).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
