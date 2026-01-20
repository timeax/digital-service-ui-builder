import type { ScaffoldConfig } from '@timeax/scaffold';

const config: ScaffoldConfig = {
  // Root for resolving the .scaffold folder & this config file.
  // By default, this is the directory where you run `scaffold`.
  // Example:
  //   root: '.',          // .scaffold at <cwd>/.scaffold
  //   root: 'tools',      // .scaffold at <cwd>/tools/.scaffold
  // root: '.',

  // Base directory where structures are applied and files/folders are created.
  // This is resolved relative to `root` above. Defaults to the same as root.
  // Example:
  //   base: '.',          // apply to <root>
  //   base: 'src',        // apply to <root>/src
  //   base: '..',         // apply to parent of <root>
  // base: '.',

  // Number of spaces per indent level in structure files (default: 2).
  // This also informs the formatter when indenting entries.
  // indentStep: 2,

  // Cache file path, relative to base.
  // cacheFile: '.scaffold-cache.json',

  // Formatting options for structure files.
  // These are used by:
  //  - `scaffold --format` (forces formatting before apply)
  //  - `scaffold --watch` when `formatOnWatch` is true
  //
  // format: {
  //   // Enable config-driven formatting in general.
  //   // `scaffold --format` always forces formatting even if this is false.
  //   enabled: true,
  //
  //   // Override indent step specifically for formatting (falls back to
  //   // top-level `indentStep` if omitted).
  //   indentStep: 2,
  //
  //   // AST mode:
  //   //  - 'loose' (default): tries to repair mild indentation issues.
  //   //  - 'strict': mostly cosmetic changes (trims trailing whitespace, etc.).
  //   mode: 'loose',
  //
  //   // Sort non-comment entries lexicographically within their parent block.
  //   // Comments and blank lines keep their relative positions.
  //   sortEntries: true,
  //
  //   // When running `scaffold --watch`, format structure files on each
  //   // detected change before applying scaffold.
  //   formatOnWatch: true,
  // },

  // --- Single-structure mode (simple) ---
  // structureFile: 'structure.txt',

  // --- Grouped mode (uncomment and adjust) ---
  // groups: [
  //   { name: 'app', root: 'app', structureFile: 'app.txt' },
  //   { name: 'frontend', root: 'resources/js', structureFile: 'frontend.txt' },
  // ],

  hooks: {
    // preCreateFile: [],
    // postCreateFile: [],
    // preDeleteFile: [],
    // postDeleteFile: [],
  },

  stubs: {
    // Example:
    // page: {
    //   name: 'page',
    //   getContent: (ctx) =>
    //     `export default function Page() { return <div>${ctx.targetPath}</div>; }`,
    // },
  }
};

export default config;
