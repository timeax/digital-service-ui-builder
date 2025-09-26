import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: [
            // react/
            {
                find: /^digital-service-ui-builder\/react\/(.*)$/,
                replacement: path.resolve(__dirname, '../src/react/$1')
            },
            {find: 'digital-service-ui-builder/react', replacement: path.resolve(__dirname, '../src/react/index.ts')},

            // core/
            {find: /^digital-service-ui-builder\/core\/(.*)$/, replacement: path.resolve(__dirname, '../src/core/$1')},
            {find: 'digital-service-ui-builder/core', replacement: path.resolve(__dirname, '../src/core/index.ts')},

            // schema/
            {
                find: /^digital-service-ui-builder\/schema\/(.*)$/,
                replacement: path.resolve(__dirname, '../src/schema/$1')
            },
            {find: 'digital-service-ui-builder/schema', replacement: path.resolve(__dirname, '../src/schema/index.ts')},

            // root export
            {find: 'digital-service-ui-builder', replacement: path.resolve(__dirname, '../src/schema/index.ts')},
            {
                find: '@',
                replacement: path.resolve(__dirname, 'src')
            }
        ],
        preserveSymlinks: true,
    },
});