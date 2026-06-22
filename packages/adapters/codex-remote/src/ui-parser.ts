// Self-contained UI run-log parser entry for the Paperclip board.
//
// External adapters expose their custom run-log rendering by exporting a
// "./ui-parser" entry (see package.json) that the server serves verbatim at
// `/api/adapters/codex_remote/ui-parser.js`. The board fetches it and evaluates
// it inside a sandboxed Web Worker, which looks for a `parseStdoutLine` export
// (see ui/src/adapters/sandboxed-parser-worker.ts).
//
// This file is bundled by esbuild into a single, dependency-free CommonJS
// module (dist/ui-parser.js). It must stay free of Node built-ins and runtime
// imports — `parse-stdout.ts` only depends on a type, so the bundle is pure.
export { parseCodexStdoutLine as parseStdoutLine } from "./ui/parse-stdout.js";
