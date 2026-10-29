// Excalidraw fetches its fonts from window.EXCALIDRAW_ASSET_PATH (D11): Kinote
// serves them itself, never a CDN. Imported first by every module that loads
// Excalidraw (the canvas, and the previews in review and history).
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/';
