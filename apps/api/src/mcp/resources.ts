import { ErrorCode, McpError, type ReadResourceResult, type Resource } from '@modelcontextprotocol/sdk/types.js';
import { capturePanelHtml } from './app/panelHtml.js';
import { CAPTURE_FILE_RESOURCE } from './tools/captureFile.js';

/** The MCP Apps mime type of a `ui://` panel. */
export const APP_MIME = 'text/html;profile=mcp-app';

/** One MCP App panel: a `ui://` resource whose HTML a host shows for a tool that names it. */
export interface AppResource {
  uri: string;
  name: string;
  description: string;
  html(): Promise<string>;
}

/** The panels this server serves. */
export const APP_RESOURCES: readonly AppResource[] = [
  {
    uri: CAPTURE_FILE_RESOURCE,
    name: 'Kinote file panel',
    description: 'Where your user drops a file for kinote_capture_file; it uploads the original and shows the receipt.',
    html: capturePanelHtml,
  },
];

export function listAppResources(resources: readonly AppResource[]): Resource[] {
  return resources.map((r) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: APP_MIME }));
}

/** `resources/read`: the panel's HTML; an unknown uri is an InvalidParams error. */
export async function readAppResource(resources: readonly AppResource[], uri: string): Promise<ReadResourceResult> {
  const r = resources.find((x) => x.uri === uri);
  if (!r) throw new McpError(ErrorCode.InvalidParams, 'Resource not found');
  return { contents: [{ uri: r.uri, mimeType: APP_MIME, text: await r.html(), _meta: { ui: { prefersBorder: true } } }] };
}
