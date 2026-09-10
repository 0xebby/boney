import {useId, type ReactNode} from "react";

/**
 * Form controls — the one look every text input, textarea, select, and checkbox on a form takes.
 *
 * Sizing: 16px on phones so iOS Safari does not zoom the page on focus, 14px from `sm` up. That is a
 * step larger than the app's table density on purpose: these fields take addresses and token amounts
 * that go into escrow, and a mistyped digit costs real money, so they are set to be read back.
 *
 * Every control is *associated* with its label through an id, not merely adjacent to it — a bare
 * sibling `<label>` leaves the input nameless to a screen reader, and to anything querying by label.
 * A hidden label (`labelHidden`) keeps that association while a column header carries the visible text.
 */

const CONTROL =
  "w-full min-w-0 rounded-md border bg-surface-2 px-3 py-2 text-base text-ink placeholder:text-ink-muted/60 disabled:opacity-50 sm:text-sm";

/** Border tone for a control: critical while invalid, hairline otherwise. */
export function controlClass(invalid?: boolean, extra = ""): string {
  return `${CONTROL} ${
    invalid ? "border-critical" : "border-hairline hover:border-hairline-strong focus:border-hairline-strong"
  } ${extra}`;
}

export function FieldLabel({
  htmlFor,
  hidden,
  children,
}: {
  htmlFor: string;
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={hidden ? "sr-only" : "mb-1.5 block text-xs font-medium text-ink-secondary"}
    >
      {children}
    </label>
  );
}

/**
 * The line under a control: the error if there is one, otherwise the hint.
 *
 * One or the other, never both — an error replaces the hint rather than stacking on it, so the
 * control's description stays a single sentence a screen reader can announce.
 */
export function FieldNote({id, error, hint}: {id: string; error?: string; hint?: ReactNode}) {
  if (error) {
    return (
      <p id={`${id}-error`} className="mt-1.5 text-xs text-critical">
        {error}
      </p>
    );
  }
  if (hint) {
    return (
      <p id={`${id}-hint`} className="mt-1.5 text-xs leading-relaxed text-ink-muted">
        {hint}
      </p>
    );
  }
  return null;
}

export function describedBy(id: string, error?: string, hint?: ReactNode): string | undefined {
  return error ? `${id}-error` : hint ? `${id}-hint` : undefined;
}

export function Field({
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  inputMode,
  mono = false,
  multiline = false,
  rows = 3,
  maxLength,
  labelHidden = false,
  autoComplete = "off",
  className = "",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: ReactNode;
  placeholder?: string;
  /** Which keyboard a phone shows. `decimal` for token amounts, `numeric` for counts. */
  inputMode?: "text" | "decimal" | "numeric" | "url";
  /** Monospace, for addresses and event signatures — a transposed hex digit is easier to spot. */
  mono?: boolean;
  /** A textarea instead of a single line. Anything a person writes in sentences belongs here. */
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  labelHidden?: boolean;
  autoComplete?: string;
  /** Wrapper classes, for sizing a short field (`sm:max-w-xs`) inside a wider column. */
  className?: string;
}) {
  const id = useId();
  const invalid = error ? true : undefined;
  const shared = {
    id,
    value,
    placeholder,
    maxLength,
    autoComplete,
    "aria-invalid": invalid,
    "aria-describedby": describedBy(id, error, hint),
    // Addresses, amounts, and signatures are never prose; a red squiggle under a hex string is noise.
    spellCheck: false,
  };

  return (
    <div className={className}>
      <FieldLabel htmlFor={id} hidden={labelHidden}>
        {label}
      </FieldLabel>
      {multiline ? (
        <textarea
          {...shared}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          className={controlClass(!!error, "resize-y leading-relaxed")}
        />
      ) : (
        <input
          {...shared}
          type="text"
          inputMode={inputMode}
          onChange={(e) => onChange(e.target.value)}
          className={controlClass(!!error, mono ? "font-mono" : "")}
        />
      )}
      <FieldNote id={id} error={error} hint={hint} />
    </div>
  );
}

/**
 * `Field`'s counterpart for a `<select>`. `value` for a controlled select, `defaultValue` for one
 * that only fires an action (a preset picker).
 */
export function SelectField({
  label,
  options,
  onChange,
  value,
  defaultValue,
  error,
  hint,
  labelHidden = false,
  className = "",
}: {
  label: string;
  options: readonly {value: string; label: string}[];
  onChange: (v: string) => void;
  value?: string;
  defaultValue?: string;
  error?: string;
  hint?: ReactNode;
  labelHidden?: boolean;
  className?: string;
}) {
  const id = useId();

  return (
    <div className={className}>
      <FieldLabel htmlFor={id} hidden={labelHidden}>
        {label}
      </FieldLabel>
      <select
        id={id}
        value={value}
        defaultValue={defaultValue}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        className={controlClass(!!error)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <FieldNote id={id} error={error} hint={hint} />
    </div>
  );
}

/**
 * A checkbox with its label as the click target and an optional second line explaining the choice.
 *
 * `accent-brand` so the tick is yellow rather than the browser's default blue, which is the one
 * colour this palette has no place for.
 */
export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
}) {
  const id = useId();

  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="block text-sm text-ink">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
