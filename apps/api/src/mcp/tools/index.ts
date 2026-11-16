import type { ToolDef } from '../tool.js';
import { askTool } from './ask.js';
import { browseTool } from './browse.js';
import { captureActionTool, captureTool } from './capture.js';
import { readTool } from './read.js';
import { relatedTool } from './related.js';
import { searchTool } from './search.js';

/** The tools `/mcp` serves, in `tools/list` order. Each needs the `read` scope. */
export const READ_TOOLS: readonly ToolDef[] = [browseTool, searchTool, readTool, relatedTool, askTool];
/** The tools that file into the wiki; each needs the `capture` scope. */
export const CAPTURE_TOOLS: readonly ToolDef[] = [captureTool, captureActionTool];
/** Everything `/mcp` serves, in `tools/list` order. */
export const ALL_TOOLS: readonly ToolDef[] = [...READ_TOOLS, ...CAPTURE_TOOLS];
