/**
 * Injection of the optional analytics arguments (`context`, `conversation_id`) into a tool's input schema
 * (feature mcp-analytics, guarantee G6). The wrapper in src/lib/tool-request.ts owns this, not a vendor SDK:
 * it adds the two arguments at registration, reads them at call time for the event, and removes the ones it
 * added before the handler runs, so a handler's own schema and arguments never change.
 */
import { z } from "zod";
import { CONTEXT_ARG, CONVERSATION_ARG } from "./event";

export const CONTEXT_DESCRIPTION =
  "Optional. One short sentence (at most 25 words) saying why you are calling this tool and what the user is trying to do, " +
  "in general terms. For Scry usage analytics only. Do not include names, emails, URLs, keys, file contents or other identifying or sensitive details.";

export const CONVERSATION_DESCRIPTION =
  "Optional. An identifier you choose for the current conversation (any short string, for example a UUID). " +
  "Pass the same value on every Scry tool call in this conversation so related calls can be grouped. For analytics only.";

/** What the wrapper knows about one registered tool's arguments. */
export interface ArgMeta {
  /** Argument names the tool declared itself (before injection); undefined when the schema kind is not understood. */
  declared: ReadonlySet<string> | undefined;
  /** Analytics arguments the wrapper added; only these are stripped before the handler. */
  injected: ReadonlySet<string>;
  /** The tool declared no input schema, so its handler takes `(extra)` and not `(args, extra)`. */
  adaptNoSchema: boolean;
}

export interface Prepared {
  /** The schema to register (the original when nothing was injected). */
  schema: unknown;
  meta: ArgMeta;
  changed: boolean;
}

type Shape = Record<string, z.ZodTypeAny>;

function isZodType(v: unknown): boolean {
  return typeof v === "object" && v !== null && ("_def" in v || "_zod" in v);
}

function isPlainShape(v: unknown): v is Shape {
  if (typeof v !== "object" || v === null || isZodType(v)) return false;
  const values = Object.values(v);
  return values.length === 0 || values.some(isZodType);
}

function isZodObject(v: unknown): v is z.ZodObject<Shape> {
  return isZodType(v) && typeof (v as { extend?: unknown }).extend === "function" && typeof (v as { shape?: unknown }).shape === "object";
}

function extra(declared: ReadonlySet<string>): { shape: Shape; injected: Set<string> } {
  const shape: Shape = {};
  const injected = new Set<string>();
  if (!declared.has(CONTEXT_ARG)) {
    shape[CONTEXT_ARG] = z.string().optional().describe(CONTEXT_DESCRIPTION);
    injected.add(CONTEXT_ARG);
  }
  if (!declared.has(CONVERSATION_ARG)) {
    shape[CONVERSATION_ARG] = z.string().optional().describe(CONVERSATION_DESCRIPTION);
    injected.add(CONVERSATION_ARG);
  }
  return { shape, injected };
}

/**
 * The schema to register for a tool whose registered input schema is `schema` (a raw zod shape, a ZodObject,
 * or undefined for none). Unknown schema kinds are left untouched (nothing injected, `changed` false).
 */
export function prepareSchema(schema: unknown): Prepared {
  const none: Prepared = { schema, meta: { declared: undefined, injected: new Set(), adaptNoSchema: false }, changed: false };
  if (schema === undefined) {
    const { shape, injected } = extra(new Set());
    return { schema: shape, meta: { declared: new Set(), injected, adaptNoSchema: true }, changed: true };
  }
  if (isPlainShape(schema)) {
    const declared = new Set(Object.keys(schema));
    const { shape, injected } = extra(declared);
    return { schema: { ...schema, ...shape }, meta: { declared, injected, adaptNoSchema: false }, changed: injected.size > 0 };
  }
  if (isZodObject(schema)) {
    const declared = new Set(Object.keys(schema.shape));
    const { shape, injected } = extra(declared);
    return { schema: schema.extend(shape), meta: { declared, injected, adaptNoSchema: false }, changed: injected.size > 0 };
  }
  return none;
}

/** The handler's arguments with the injected analytics arguments removed (a copy; the input is not mutated). */
export function stripInjected(args: unknown, injected: ReadonlySet<string>): unknown {
  if (injected.size === 0 || !args || typeof args !== "object" || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!injected.has(k)) out[k] = v;
  return out;
}

export { isPlainShape };
