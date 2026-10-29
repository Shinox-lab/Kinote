import { createContext, useContext } from 'react';

/** Where the page being edited lives, for blocks that act on it (a collection view can make it a collection). */
export interface EditorPlaceValue {
  pageId: string;
  spaceId: string;
}

export const EditorPlaceContext = createContext<EditorPlaceValue | null>(null);

export const useEditorPlace = () => useContext(EditorPlaceContext);
