import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@/hooks/use-session", replacement: path.resolve("qa/quota/session.ts") },
      { find: "@/lib/hono-client", replacement: path.resolve("qa/quota/client.ts") },
      { find: "@", replacement: path.resolve("src") },
    ],
  },
  server: { host: "127.0.0.1", port: 5189, strictPort: true },
});
