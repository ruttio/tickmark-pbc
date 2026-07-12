import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

// Two separate entrances → two separate bundles:
//   index.html   = firm app  (authenticated staff)
//   client.html  = client portal (code + token, no login)
// The client bundle never includes the firm app's code or data.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        client: resolve(__dirname, "client.html"),
      },
    },
  },
  // Vitest — unit tests for the pure data-layer / logic helpers.
  // jsdom so importing the app modules (which touch localStorage via supabase-js)
  // doesn't blow up; the tests themselves exercise pure functions only.
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{js,jsx}"],
  },
});
