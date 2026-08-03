import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// @ts-expect-error Vite supports query-string imports used to invalidate tunnel caches.
import { App } from "./App.tsx?v=new-piano-organ-song-50";
import "./styles.css?v=new-piano-organ-song-50";

const root = document.querySelector<HTMLDivElement>("#root");

if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
