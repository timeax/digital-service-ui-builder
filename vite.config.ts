import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "node:path";

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "src"),
        },
    },
    test: {
        globals: true,
        environment: "jsdom",
        include: ["src/**/*.{test,spec}.{ts,tsx}"],
        setupFiles: ["./vitest.setup.ts"],
    },
});
