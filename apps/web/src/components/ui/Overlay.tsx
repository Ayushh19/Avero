import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cx } from '../../lib/cx';
import styles from './Overlay.module.css';

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Native <dialog> gives focus trapping, Esc-to-close, inert background and top-layer stacking.
 * Closing animates out before the element is actually closed.
 */
function useNativeDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      document.documentElement.style.overflow = 'hidden';
    } else if (!open && el.open) {
      el.dataset.closing = 'true';
      const done = () => {
        delete el.dataset.closing;
        el.close();
      };
      const t = setTimeout(done, 250);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    const onCloseEvent = () => {
      document.documentElement.style.overflow = '';
    };
    el.addEventListener('cancel', onCancel);
    el.addEventListener('close', onCloseEvent);
    return () => {
      el.removeEventListener('cancel', onCancel);
      el.removeEventListener('close', onCloseEvent);
    };
  }, [onClose]);

  // Click on the backdrop (the dialog element itself, outside its content) closes it.
  const onClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) onClose();
  };
  return { ref, onClick };
}

export function Dialog({ open, onClose, title, children, footer, size = 'md' }: OverlayProps & { size?: 'md' | 'lg' }) {
  const { ref, onClick } = useNativeDialog(open, onClose);
  return (
    <dialog ref={ref} className={cx(styles.overlay, styles.dialog, size === 'lg' && styles.dialogLg)} onClick={onClick} aria-label={title}>
      <div className={styles.panel}>
        <div className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={20} aria-hidden />
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.foot}>{footer}</footer> : null}
      </div>
    </dialog>
  );
}

export function Drawer({ open, onClose, title, children, footer, side = 'right' }: OverlayProps & { side?: 'left' | 'right' }) {
  const { ref, onClick } = useNativeDialog(open, onClose);
  return (
    <dialog ref={ref} className={cx(styles.overlay, styles.drawer, styles[side])} onClick={onClick} aria-label={title}>
      <div className={styles.panel}>
        <div className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={20} aria-hidden />
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.foot}>{footer}</footer> : null}
      </div>
    </dialog>
  );
}

/* ---------- toasts ---------- */

type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  show: (message: string, opts?: { tone?: ToastTone; action?: ToastItem['action']; durationMs?: number }) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TOAST_ICON = { success: CheckCircle2, error: AlertCircle, info: Info } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const show = useCallback<ToastApi['show']>(
    (message, opts = {}) => {
      const id = nextId.current++;
      setToasts((t) => [...t.slice(-2), { id, message, tone: opts.tone ?? 'info', action: opts.action }]);
      setTimeout(() => dismiss(id), opts.durationMs ?? (opts.action ? 7000 : 4500));
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (m) => show(m, { tone: 'success' }),
      error: (m) => show(m, { tone: 'error' }),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.toasts} role="region" aria-label="Notifications">
        <div aria-live="polite" aria-atomic="false">
          {toasts.map((t) => {
            const Icon = TOAST_ICON[t.tone];
            return (
              <div key={t.id} className={cx(styles.toast, styles[`toast-${t.tone}`])} role={t.tone === 'error' ? 'alert' : 'status'}>
                <Icon size={18} aria-hidden className={styles.toastIcon} />
                <p>{t.message}</p>
                {t.action ? (
                  <button
                    type="button"
                    className={styles.toastAction}
                    onClick={() => {
                      t.action!.onClick();
                      dismiss(t.id);
                    }}
                  >
                    {t.action.label}
                  </button>
                ) : null}
                <button type="button" className={styles.toastClose} onClick={() => dismiss(t.id)} aria-label="Dismiss">
                  <X size={16} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
