import { useRef, useState } from 'react';

/**
 * The title of a row being renamed: a text field in place of the row's name.
 * Enter saves it, Escape cancels it, and leaving the field with a name in it
 * saves it too (an empty one cancels).
 */
export function TitleInput({
  title,
  onSave,
  onCancel,
}: {
  /** The name the row has now. */
  title: string;
  onSave: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(title);
  const done = useRef(false);

  function save() {
    if (done.current) return;
    done.current = true;
    const clean = value.trim();
    if (clean === '') onCancel();
    else onSave(clean);
  }

  return (
    <input
      autoFocus
      value={value}
      aria-label="New title"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          save();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={save}
      className="w-full min-w-0 flex-1 rounded-md border border-line bg-page px-2 py-1 text-sm text-fg"
    />
  );
}
