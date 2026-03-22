import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "path";

const INPUT = process.env.INPUT;
if (!INPUT) {
  throw new Error("INPUT environment variable is not set. Usage: INPUT=web/widgets/widget.html vite build");
}

export default defineConfig({
  root: path.dirname(INPUT),
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: path.resolve("web/dist/widgets"),
    emptyOutDir: false,
    rollupOptions: {
      input: path.resolve(INPUT),
    },
  },
});
