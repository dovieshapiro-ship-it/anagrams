import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// @ts-expect-error Vite supports query-string imports used to invalidate tunnel caches.
import { App } from "./App.tsx?v=sampled-grand-piano-51";
import { PublicPage } from "./PublicPages";
import "./styles.css?v=sampled-grand-piano-51";

const root = document.querySelector<HTMLDivElement>("#root");

if (!root) throw new Error("Root element not found");

const publicPage = window.location.pathname === "/privacy"
  ? "privacy"
  : window.location.pathname === "/marketing"
    ? "marketing"
    : undefined;

createRoot(root).render(
  <StrictMode>
    {publicPage ? <PublicPage kind={publicPage} /> : <App />}
  </StrictMode>,
);
