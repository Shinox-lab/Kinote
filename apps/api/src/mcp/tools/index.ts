import type { ToolDef } from '../tool.js';
import { readTool } from './read.js';
import { searchTool } from './search.js';

/** The tools `/mcp` serves, in `tools/list` order. Each needs the `read` scope. */
export const READ_TOOLS: readonly ToolDef[] = [searchTool, readTool];
