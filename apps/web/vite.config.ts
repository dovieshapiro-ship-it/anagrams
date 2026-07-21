import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    ...(process.env.PUBLIC_DEV_HOST
      ? { allowedHosts: [process.env.PUBLIC_DEV_HOST] }
      : {}),
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET ?? "http://localhost:3001",
        changeOrigin: false,
      },
    },
  },
  preview: { port: 3000 },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
