#!/usr/bin/env node
// Print the schema hash and tokens of a vendored scry-log copy. Derived from scry-management/scripts/scry-log-schema.mjs
// (the reader scripts/logs-deploy-check.sh uses), with one change: the hash function is the copy's OWN schema-hash.ts,
// because a service repo has no scry-management checkout. sync.sh vendors schema-hash.ts with the rest, so the numbers
// match what the logs Worker computes for the same schema.
//
//   scry-log-schema.mjs <dir-with-the-copy's-.ts-files>           JSON {hash, entries, tokens}
//   scry-log-schema.mjs <dir> --hash                              just the hash
//
// Needs the `typescript` package, found from the current directory or NODE_PATH. Exit 2 usage, 3 not a (current)
// scry-log copy, 4 typescript missing.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: scry-log-schema.mjs <dir> [--hash]');
  process.exit(2);
}

function findTypescript() {
  try {
    return createRequire(path.join(process.cwd(), 'x.js'))('typescript');
  } catch {
    console.error('typescript not found from the current directory or NODE_PATH. Run: npm install typescript (or pnpm install)');
    process.exit(4);
  }
}
const ts = findTypescript();

/** A tiny module system over a directory of .ts files: transpile to CommonJS, resolve ./name inside the directory. */
function loader(d) {
  const cache = new Map();
  const has = (name) => fs.existsSync(path.join(d, `${name}.ts`));
  const load = (name) => {
    if (cache.has(name)) return cache.get(name).exports;
    const file = path.join(d, `${name}.ts`);
    const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    const mod = { exports: {} };
    cache.set(name, mod);
    const req = (spec) => {
      if (spec.startsWith('./')) return load(spec.slice(2).replace(/\.ts$/, ''));
      throw new Error(`unexpected import ${spec} in ${name}.ts`);
    };
    // eslint-disable-next-line sonarjs/code-eval -- runs only the vendored scry-log .ts files of this repo, transpiled just above
    new Function('exports', 'require', 'module', out.outputText)(mod.exports, req, mod);
    return mod.exports;
  };
  return { has, load };
}

const target = loader(dir);
if (!target.has('schema')) {
  console.error(`not a scry-log copy (no schema.ts): ${dir}`);
  process.exit(3);
}
if (!target.has('schema-hash')) {
  console.error(`this scry-log copy predates the schema hash (no schema-hash.ts): ${dir}. Run scry-management/lib/scry-log/sync.sh <this repo>`);
  process.exit(3);
}
const schema = target.load('schema');
const attrs = target.has('attrs-registry') ? target.load('attrs-registry').ATTRS ?? {} : {};
const shape = {
  version: schema.SCHEMA_VERSION,
  allowedKeys: schema.ALLOWED_KEYS ?? [],
  enumValues: schema.ENUM_VALUES ?? {},
  services: schema.SERVICES ?? [],
  envs: schema.ENVS ?? [],
  levels: schema.LEVELS ?? [],
  attrs,
};
const tool = target.load('schema-hash');
const hash = tool.schemaHash(shape);
if (args.includes('--hash')) console.log(hash);
else {
  const tokens = tool.schemaTokens(shape);
  console.log(JSON.stringify({ hash, entries: tokens.length, tokens }));
}
