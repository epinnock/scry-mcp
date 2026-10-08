// scry-log attribute registry: the ONLY place a log attribute is declared. Zero dependencies.
// Source of truth: scry-management/lib/scry-log/. Vendored into services by sync.sh; do not edit copies.
//
// A line may carry `attrs`, an object of registered, typed values (schema v1, additive). Anything not declared here is
// dropped and counted (`attrs_drop`). To add an attribute: one entry below + one test in test/attrs.test.ts; see README
// "How to add a log attribute". Never register free text from a user or an agent (prompts, intents, argument values, bodies).
import type { Service } from './schema';

export type AttrType = 'id' | 'token' | 'string' | 'int' | 'bool' | 'token_list';

export interface AttrDef {
  type: AttrType;
  /**
   * id: max length (default and ceiling 128). token: max length (default 64, ceiling 128). string: max length (default and
   * ceiling 256). int: largest allowed value (default Number.MAX_SAFE_INTEGER). token_list: max length of each item
   * (default 64, ceiling 128). bool: unused.
   */
  max?: number;
  /** Extra shape the value (or each token_list item) must match, on top of the type's own rule. */
  pattern?: RegExp;
  /** Services allowed to send it. Omitted: any service. */
  services?: ReadonlyArray<Service>;
  description: string;
}

/** `ns.name`: lowercase namespace, a dot, a lowercase name of at most 40 chars. */
export const ATTR_NAME = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]{0,39}$/;

/** Limits per line. Beyond them an attribute is dropped and counted, never truncated. */
export const MAX_ATTRS = 24;
export const MAX_ATTRS_BYTES = 2048;
export const MAX_LIST_ITEMS = 32;

const MCP: ReadonlyArray<Service> = ['mcp'];

export const ATTRS: Readonly<Record<string, AttrDef>> = {
  // --- mcp (feature mcp-analytics): one mcp_tool_call line per tool call; see scry-mcp src/analytics/event.ts ---
  'mcp.session_id': { type: 'id', services: MCP, description: 'MCP session (Durable Object) id, e.g. do_<16 hex>' },
  'mcp.conversation_id': { type: 'id', services: MCP, description: 'Conversation id the agent passed in the conversation_id argument' },
  'mcp.client_name': { type: 'token', max: 64, services: MCP, description: 'MCP client name from the initialize handshake' },
  'mcp.client_version': { type: 'token', max: 32, services: MCP, description: 'MCP client version from the initialize handshake' },
  'mcp.protocol_version': { type: 'token', max: 16, services: MCP, description: 'MCP protocol version negotiated at initialize' },
  'mcp.llm_model': { type: 'token', max: 64, services: MCP, description: 'Model the client stated in request metadata; never inferred' },
  'mcp.llm_model_source': { type: 'token', max: 32, services: MCP, description: 'Where llm_model came from (client_metadata)' },
  'mcp.input_keys': { type: 'token_list', max: 64, services: MCP, description: 'Names of the declared arguments that were present; never values' },
  'mcp.response_bytes': { type: 'int', services: MCP, description: 'Size of the tool result in bytes; never the body' },
  'mcp.has_intent': { type: 'bool', services: MCP, description: 'The call carried a context (intent) argument; the text is never logged' },
  'mcp.intent_source': { type: 'token', max: 32, services: MCP, description: 'Where the intent came from (context_parameter)' },
  'mcp.missing_capability': { type: 'bool', services: MCP, description: 'The agent called get_more_tools: it wanted a capability Scry lacks' },
  'mcp.server_build': { type: 'token', max: 64, services: MCP, description: 'Deployed server build (commit sha or version)' },
  'mcp.tool_count': { type: 'int', max: 10000, services: MCP, description: 'Number of tools returned by tools/list' },
};
