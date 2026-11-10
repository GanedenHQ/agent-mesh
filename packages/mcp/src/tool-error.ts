/**
 * Application failures must come back as tool RESULTS, not thrown exceptions.
 *
 * A handler that throws lets the error escape into the JSON-RPC transport layer,
 * where the client can only describe it as a transport problem — a refusal (loop guard,
 * unknown recipient) then reads as "Unable to connect. Is the computer able to access
 * the url?" and sends the human hunting for an infra outage that never happened
 *. Wrapping the handler keeps the server's own
 * words: the MCP contract says a failed tool call returns `isError: true` with the
 * reason as text.
 */

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** Wraps a tool handler so any thrown failure returns as an `isError` result. */
export function guarded<A extends unknown[]>(
  handler: (...args: A) => Promise<ToolResult>,
): (...args: A) => Promise<ToolResult> {
  return async (...args: A): Promise<ToolResult> => {
    try {
      return await handler(...args);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[agent-mesh] tool failed: ${reason}\n`);
      return { content: [{ type: 'text', text: `❌ ${reason}` }], isError: true };
    }
  };
}
