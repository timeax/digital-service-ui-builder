// noinspection JSUnusedGlobalSymbols

import { defineConfig } from 'tsup';

// noinspection JSUnusedGlobalSymbols
export default defineConfig([
    {
        entry: {
            'schema/index': 'src/schema/index.ts',
            'schema/editor': 'src/schema/editor.ts',
            'schema/provider': 'src/schema/provider.ts',
            'schema/validation': 'src/schema/validation.ts',
            'schema/graph': 'src/schema/graph.ts',
            'schema/policies': 'src/schema/policies.ts'
        },
        dts: true,
        format: ['esm', 'cjs'],
        sourcemap: true,
        outDir: 'dist',
        clean: false
    },
    {
        entry: { 'core/index': 'src/core/index.ts' },
        dts: true,
        format: ['esm', 'cjs'],
        sourcemap: true,
        outDir: 'dist',
        clean: false,
        external: [] // keep core light
    },
    {
        entry: { 'react/index': 'src/react/index.ts' },
        dts: true,
        format: ['esm', 'cjs'],
        sourcemap: true,
        outDir: 'dist',
        clean: false,
        external: ['react', 'react-dom', 'reactflow'] // peer deps
    }
]);