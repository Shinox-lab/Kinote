import { useId, type ComponentProps, type ReactNode } from 'react';
import { errorMessage } from '../lib/api.js';

// Small shared pieces of the console: labelled fields, buttons and the one place
// an error becomes text (always through errorMessage, never the raw error).

const CONTROL =
  'w-full rounded-md border border-line bg-page px-3 py-2 text-sm text-fg placeholder:text-muted disabled:bg-hover disabled:text-muted';

export function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email' | 'password';
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  pattern?: string;
  hint?: string;
  readOnly?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {props.label}
      </label>
      <input
        id={id}
        className={CONTROL}
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete={props.autoComplete}
        required={props.required}
        minLength={props.minLength}
        pattern={props.pattern}
        readOnly={props.readOnly}
        aria-describedby={props.hint ? `${id}-hint` : undefined}
      />
      {props.hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
          {props.hint}
        </p>
      )}
    </div>
  );
}

export function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Hide the label visually (it stays for screen readers), for selects inside a table row. */
  compact?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={props.compact ? 'sr-only' : 'mb-1 block text-sm font-medium'}>
        {props.label}
      </label>
      <select
        id={id}
        className={CONTROL}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value as T)}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Checkbox(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="checkbox"
        className="size-4 rounded border-line accent-accent"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <label htmlFor={id} className="text-sm">
        {props.label}
      </label>
    </div>
  );
}

const BUTTON = {
  primary: 'bg-accent text-accent-fg hover:opacity-90',
  secondary: 'border border-line bg-page text-fg hover:bg-hover',
  danger: 'border border-danger bg-page text-danger hover:bg-danger-bg',
};

export function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  ...rest
}: ComponentProps<'button'> & { variant?: keyof typeof BUTTON }) {
  return (
    <button
      type={type}
      className={`rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11 ${BUTTON[variant]} ${className}`}
      {...rest}
    />
  );
}

/** Shows what went wrong for a thrown value (nothing when there is none). */
export function ErrorNote({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  return (
    <p role="alert" className="rounded-md border border-danger bg-danger-bg px-3 py-2 text-sm text-danger">
      {errorMessage(error)}
    </p>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <section aria-labelledby={title ? titleId : undefined} className="rounded-lg border border-line bg-surface p-5">
      {title && (
        <h2 id={titleId} className="mb-3 text-base font-semibold">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

/** A centred card for the sign-in style screens. */
export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-4 py-10">
      <h1 className="text-2xl font-semibold">Living Wiki</h1>
      <Card title={title}>{children}</Card>
    </main>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="text-sm text-muted">
      Loading {what}…
    </p>
  );
}
