import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// DFH Workstation 团队管理面板原型 — Vite 配置
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
