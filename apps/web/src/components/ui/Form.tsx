import { AlertCircle, Check, ChevronDown } from 'lucide-react';
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from '../../lib/cx';
import styles from './Form.module.css';

interface FieldShellProps {
  id: string;
  label: string;
  error?: string;
  hint?: ReactNode;
  labelAction?: ReactNode;
  children: ReactNode;
}

function FieldShell({ id, label, error, hint, labelAction, children }: FieldShellProps) {
  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
        {labelAction}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} className={styles.error} role="alert">
          <AlertCircle size={14} aria-hidden /> {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className={styles.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, error?: string, hint?: ReactNode) {
  return error ? `${id}-error` : hint ? `${id}-hint` : undefined;
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  name: string;
  error?: string;
  hint?: ReactNode;
  labelAction?: ReactNode;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, name, error, hint, labelAction, className, id: idProp, ...input },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? `${name}-${autoId}`;
  return (
    <FieldShell id={id} label={label} error={error} hint={hint} labelAction={labelAction}>
      <input
        ref={ref}
        id={id}
        name={name}
        className={cx(styles.control, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        {...input}
      />
    </FieldShell>
  );
});

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  name: string;
  error?: string;
  hint?: ReactNode;
}

export function SelectField({ label, name, error, hint, children, className, ...select }: SelectFieldProps) {
  const id = `${name}-${useId()}`;
  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      <div className={styles.selectWrap}>
        <select
          id={id}
          name={name}
          className={cx(styles.control, styles.select, className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, error, hint)}
          {...select}
        >
          {children}
        </select>
        <ChevronDown size={16} className={styles.selectIcon} aria-hidden />
      </div>
    </FieldShell>
  );
}

/** Compact inline select without a visible label block (e.g. "Sort by"). */
export function InlineSelect({
  label,
  children,
  className,
  ...select
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <label className={cx(styles.inlineSelect, className)}>
      <span className="meta">{label}</span>
      <span className={styles.selectWrap}>
        <select className={styles.inlineSelectControl} {...select}>
          {children}
        </select>
        <ChevronDown size={14} className={styles.selectIcon} aria-hidden />
      </span>
    </label>
  );
}

interface TextareaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  name: string;
  error?: string;
  hint?: ReactNode;
}

export function TextareaField({ label, name, error, hint, className, ...rest }: TextareaFieldProps) {
  const id = `${name}-${useId()}`;
  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      <textarea
        id={id}
        name={name}
        className={cx(styles.control, styles.textarea, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        {...rest}
      />
    </FieldShell>
  );
}

export function Checkbox({ label, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={styles.check}>
      <input type="checkbox" className={styles.checkInput} {...input} />
      <span className={styles.checkBox} aria-hidden>
        <Check size={12} strokeWidth={3} />
      </span>
      <span>{label}</span>
    </label>
  );
}

interface RadioCardProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  action?: ReactNode;
}

/** Bordered selectable card for addresses, delivery methods, payment methods. */
export function RadioCard({ title, description, aside, action, className, ...input }: RadioCardProps) {
  return (
    <div className={cx(styles.radioCard, className)}>
      <label className={styles.radioCardLabel}>
        <input type="radio" className={styles.radioInput} {...input} />
        <span className={styles.radioDot} aria-hidden />
        <span className={styles.radioBody}>
          <span className={styles.radioTitle}>{title}</span>
          {description ? <span className={styles.radioDesc}>{description}</span> : null}
        </span>
        {aside ? <span className={styles.radioAside}>{aside}</span> : null}
      </label>
      {action ? <div className={styles.radioAction}>{action}</div> : null}
    </div>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className={styles.formError} role="alert">
      <AlertCircle size={18} aria-hidden />
      <p>{message}</p>
    </div>
  );
}
