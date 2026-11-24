import type { ToolDef } from '../tool.js';
import { askTool } from './ask.js';
import { browseTool } from './browse.js';
import { captureActionTool, captureTool } from './capture.js';
import { UPLOAD_TOOLS } from './upload.js';
import { deleteTool } from './delete.js';
import { downloadTool } from './download.js';
import { editTool } from './edit.js';
import { readTool } from './read.js';
import { relatedTool } from './related.js';
import { replaceTool } from './replace.js';
import { reviewDecideTool, reviewListTool, reviewTool } from './review.js';
import { searchTool } from './search.js';
import { TREE_TOOLS } from './tree.js';

/** The tools `/mcp` serves, in `tools/list` order. Each needs the `read` scope. */
export const READ_TOOLS: readonly ToolDef[] = [browseTool, searchTool, readTool, downloadTool, relatedTool, askTool, reviewTool, reviewListTool];
/** The tools that file into the wiki; each needs the `capture` scope. */
export const CAPTURE_TOOLS: readonly ToolDef[] = [captureTool, captureActionTool, ...UPLOAD_TOOLS];
/** The tools that change pages directly; each needs the `edit` scope. */
export const EDIT_TOOLS: readonly ToolDef[] = [editTool, replaceTool, ...TREE_TOOLS, deleteTool, reviewDecideTool];
/** Everything `/mcp` serves, in `tools/list` order. */
export const ALL_TOOLS: readonly ToolDef[] = [...READ_TOOLS, ...CAPTURE_TOOLS, ...EDIT_TOOLS];
