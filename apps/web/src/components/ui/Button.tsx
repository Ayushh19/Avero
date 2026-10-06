import { ArrowRight, LoaderCircle } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cx } from '../../lib/cx';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface StyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

export function buttonClass({ variant = 'primary', size = 'md', fullWidth }: StyleProps, extra?: string) {
  return cx(styles.button, styles[variant], styles[size], fullWidth && styles.full, extra);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, StyleProps {
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, fullWidth, loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass({ variant, size, fullWidth }, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <LoaderCircle className={styles.spinner} size={18} aria-hidden /> : icon}
      <span className={cx(loading && styles.hiddenLabel)}>{children}</span>
    </button>
  );
});

export function ButtonLink({ variant, size, fullWidth, className, ...rest }: LinkProps & StyleProps) {
  return <Link className={buttonClass({ variant, size, fullWidth }, className)} {...rest} />;
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  shape?: 'circle' | 'square';
  bordered?: boolean;
  pressed?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shape = 'circle', bordered, pressed, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cx(styles.icon, styles[shape], bordered && styles.bordered, className)}
      {...rest}
    >
      {children}
    </button>
  );
});

/** Circular outlined arrow — the editorial "explore" affordance. */
export function ArrowLink({ to, label, className }: { to: string; label: string; className?: string }) {
  return (
    <Link to={to} aria-label={label} title={label} className={cx(styles.arrow, className)}>
      <ArrowRight size={20} strokeWidth={1.5} aria-hidden />
    </Link>
  );
}
