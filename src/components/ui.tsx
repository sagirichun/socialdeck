"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { X, Check, AlertTriangle, Info, Loader2, ChevronDown } from "lucide-react";

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

/* ---------------------------------- layout --------------------------------- */

export function Card({
  children,
  className,
  as: Tag = "section",
}: {
  children: React.ReactNode;
  className?: string;
  as?: any;
}) {
  return (
    <Tag className={cn("rounded-[10px] border border-line bg-surface", className)}>{children}</Tag>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  icon: Icon,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex items-start justify-between gap-4 border-b border-line px-4 py-3",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {Icon ? (
          <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border border-line bg-raised text-ink-dim">
            <Icon size={13} />
          </span>
        ) : null}
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-[11.5px] text-ink-mute">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function CardBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("px-4 py-3.5", className)}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[19px] font-semibold tracking-tight text-ink">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink-mute">{description}</p>
        ) : null}
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-3 text-[11.5px] text-ink-faint">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Grid({
  cols = 4,
  children,
  className,
}: {
  cols?: 2 | 3 | 4 | 5 | 6;
  children: React.ReactNode;
  className?: string;
}) {
  const map: Record<number, string> = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-2 lg:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
    5: "sm:grid-cols-2 lg:grid-cols-5",
    6: "sm:grid-cols-3 lg:grid-cols-6",
  };
  return <div className={cn("grid grid-cols-1 gap-3", map[cols], className)}>{children}</div>;
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn("border-0 border-t border-line", className)} />;
}

/* --------------------------------- indicators ------------------------------- */

export type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "muted";

const TONES: Record<Tone, string> = {
  neutral: "border-line-strong bg-raised text-ink-dim",
  good: "border-good/30 bg-good-soft text-good",
  warn: "border-warn/30 bg-warn-soft text-warn",
  bad: "border-bad/30 bg-bad-soft text-bad",
  info: "border-accent/30 bg-accent-soft text-accent",
  muted: "border-line bg-transparent text-ink-faint",
};

export function Badge({
  children,
  tone = "neutral",
  dot,
  className,
  mono,
}: {
  children: React.ReactNode;
  tone?: Tone;
  dot?: boolean;
  className?: string;
  mono?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] text-[11px] font-medium leading-none",
        TONES[tone],
        mono && "font-mono text-[10.5px] tracking-tight",
        className,
      )}
    >
      {dot ? <span className={cn("h-1.5 w-1.5 rounded-full bg-current", tone === "bad" && "live-dot")} /> : null}
      {children}
    </span>
  );
}

export function statusTone(status: string): Tone {
  switch (status) {
    case "published":
    case "sent":
    case "connected":
    case "live":
    case "ok":
    case "completed":
    case "approved":
      return "good";
    case "failed":
    case "error":
    case "revoked":
    case "crisis":
      return "bad";
    case "scheduled":
    case "queued":
    case "starting":
    case "publishing":
    case "stopping":
    case "sensitive":
    case "pending":
    case "active":
    case "delayed":
      return "warn";
    case "draft":
    case "idle":
    case "cancelled":
    case "rejected":
    case "blocked":
    case "expired":
    case "spam":
    case "skipped":
      return "muted";
    default:
      return "neutral";
  }
}

export function StatTile({
  label,
  value,
  unit,
  delta,
  hint,
  tone = "neutral",
  icon: Icon,
  footer,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  delta?: number | null;
  hint?: string;
  tone?: Tone;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  footer?: React.ReactNode;
}) {
  const deltaTone: Tone = delta === null || delta === undefined ? "muted" : delta >= 0 ? "good" : "bad";
  return (
    <div className="rounded-[10px] border border-line bg-surface p-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint">{label}</span>
        {Icon ? <Icon size={14} className="text-ink-faint" /> : null}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className={cn("tnum text-[24px] font-semibold leading-none tracking-tight", tone === "bad" ? "text-bad" : tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : "text-ink")}>
          {value}
        </span>
        {unit ? <span className="text-[11.5px] text-ink-mute">{unit}</span> : null}
      </div>
      <div className="mt-2 flex items-center gap-2">
        {delta !== undefined && delta !== null ? (
          <Badge tone={deltaTone}>
            {delta >= 0 ? "+" : ""}
            {delta.toFixed(1)}%
          </Badge>
        ) : null}
        {hint ? <span className="truncate text-[11px] text-ink-faint">{hint}</span> : null}
      </div>
      {footer ? <div className="mt-2.5 border-t border-line pt-2.5">{footer}</div> : null}
    </div>
  );
}

export function LiveDot({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-good">
      <span className="live-dot h-1.5 w-1.5 rounded-full bg-good" />
      {label}
    </span>
  );
}

export function ProgressBar({ value, tone = "info" }: { value: number; tone?: Tone }) {
  const palette: Record<string, string> = {
    good: "bg-good",
    warn: "bg-warn",
    bad: "bg-bad",
    info: "bg-accent",
    neutral: "bg-ink-faint",
    muted: "bg-ink-faint",
  };
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", palette[tone])}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-md", className)} />;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {Icon ? (
        <span className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-raised text-ink-faint">
          <Icon size={16} />
        </span>
      ) : null}
      <p className="text-[13px] font-medium text-ink-dim">{title}</p>
      {description ? <p className="max-w-sm text-[12px] leading-relaxed text-ink-faint">{description}</p> : null}
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}

/* ---------------------------------- controls -------------------------------- */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost" | "danger" | "subtle";
  size?: "xs" | "sm" | "md";
  loading?: boolean;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
};

export function Button({
  variant = "outline",
  size = "md",
  loading,
  icon: Icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const variants: Record<string, string> = {
    primary: "bg-accent text-white border-accent hover:bg-accent/90",
    outline: "border-line-strong bg-raised text-ink hover:bg-overlay",
    ghost: "border-transparent bg-transparent text-ink-dim hover:bg-raised hover:text-ink",
    subtle: "border-transparent bg-overlay text-ink-dim hover:text-ink",
    danger: "border-bad/40 bg-bad-soft text-bad hover:bg-bad/15",
  };
  const sizes: Record<string, string> = {
    xs: "h-6 px-2 text-[11px] gap-1",
    sm: "h-7 px-2.5 text-[12px] gap-1.5",
    md: "h-8 px-3 text-[12.5px] gap-2",
  };
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        "inline-flex select-none items-center justify-center whitespace-nowrap rounded-[7px] border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {loading ? <Loader2 size={13} className="animate-spin" /> : Icon ? <Icon size={13} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  icon: Icon,
  label,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
}) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-[7px] border border-line bg-raised text-ink-dim transition-colors hover:text-ink disabled:opacity-50",
        className,
      )}
    >
      <Icon size={13} />
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-ink-dim">
        {label}
        {required ? <span className="text-bad">*</span> : null}
      </span>
      {children}
      {hint && !error ? <span className="mt-1 block text-[11px] text-ink-faint">{hint}</span> : null}
      {error ? <span className="mt-1 block text-[11px] text-bad">{error}</span> : null}
    </label>
  );
}

const controlCls =
  "w-full rounded-[7px] border border-line-strong bg-raised px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-ink-faint transition-colors focus:border-accent/60 focus:outline-none disabled:opacity-60";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  const { className, mono, ...rest } = props;
  return <input {...rest} className={cn(controlCls, mono && "font-mono text-[12px]", "h-8", className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, ...rest } = props;
  return <textarea {...rest} className={cn(controlCls, "leading-relaxed", className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, children, ...rest } = props;
  return (
    <div className="relative">
      <select {...rest} className={cn(controlCls, "h-8 appearance-none pr-8", className)}>
        {children}
      </select>
      <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[12.5px] font-medium text-ink">
          {label}
        </label>
        {hint ? <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{hint}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-[18px] w-[32px] shrink-0 rounded-full border transition-colors disabled:opacity-50",
          checked ? "border-accent bg-accent" : "border-line-strong bg-raised",
        )}
      >
        <span
          className={cn(
            "absolute top-[2px] h-[12px] w-[12px] rounded-full bg-white transition-all",
            checked ? "left-[16px]" : "left-[2px]",
          )}
        />
      </button>
    </div>
  );
}

type TabItem = { key?: string; value?: string; label: string; count?: number };

/** Accepts both call styles: {tabs,active} and {items,value}. Normalised once, here. */
export function Tabs({
  tabs,
  active,
  items,
  value,
  onChange,
  className,
}: {
  tabs?: TabItem[];
  active?: string;
  items?: TabItem[];
  value?: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  const list = tabs ?? items ?? [];
  const current = active ?? value ?? "";
  return (
    <div className={cn("flex items-center gap-1 border-b border-line", className)}>
      {list.map((t) => (
        <button
          key={t.key ?? t.value}
          onClick={() => onChange(String(t.key ?? t.value))}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-[12.5px] font-medium transition-colors",
            current === (t.key ?? t.value)
              ? "border-accent text-ink"
              : "border-transparent text-ink-mute hover:text-ink-dim",
          )}
        >
          {t.label}
          {t.count !== undefined ? (
            <span className="tnum ml-1.5 text-[11px] text-ink-faint">{t.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------- modal ---------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[8vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "animate-in w-full rounded-[10px] border border-line-strong bg-surface shadow-2xl",
          width,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-[13.5px] font-semibold text-ink">{title}</h2>
            {description ? <p className="mt-0.5 text-[11.5px] text-ink-mute">{description}</p> : null}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} className="border-transparent bg-transparent" />
        </div>
        <div className="max-h-[64vh] overflow-y-auto px-4 py-3.5">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

/* ----------------------------------- table ---------------------------------- */

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-left", className)}>{children}</table>
    </div>
  );
}

export function Th({
  children,
  className,
  align = "left",
  width,
}: {
  children?: React.ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
  width?: number | string;
}) {
  return (
    <th
      style={width ? { width } : undefined}
      className={cn(
        "whitespace-nowrap border-b border-line px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  align = "left",
  mono,
  colSpan,
  title,
  width,
}: {
  children?: React.ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
  mono?: boolean;
  colSpan?: number;
  title?: string;
  width?: number | string;
}) {
  return (
    <td
      colSpan={colSpan}
      title={title}
      style={width ? { width } : undefined}
      className={cn(
        "border-b border-line/70 px-3 py-2.5 align-middle text-[12.5px] text-ink-dim",
        align === "right" && "text-right tnum",
        align === "center" && "text-center",
        mono && "font-mono text-[11.5px]",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Tr({
  children,
  className,
  onClick,
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <tr
      onClick={onClick}
      className={cn("transition-colors hover:bg-raised/60", onClick && "cursor-pointer", className)}
    >
      {children}
    </tr>
  );
}

/* ---------------------------------- toasts ---------------------------------- */

type Toast = { id: number; tone: "good" | "bad" | "info" | "warn"; message: string };
const ToastCtx = createContext<{ push: (tone: Toast["tone"], message: string) => void }>({
  push: () => {},
});

export function useToast() {
  return useContext(ToastCtx);
}

/** Screens import `useToast` from either the ui module or the client module. */
export const toast = useToast;

export function ToastHost({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast["tone"], message: string) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, tone, message }]);
    setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== id)), 5200);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[340px] flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              "animate-in pointer-events-auto flex items-start gap-2.5 rounded-[8px] border px-3 py-2.5 text-[12.5px] shadow-xl",
              t.tone === "good" && "border-good/30 bg-good-soft text-good",
              t.tone === "bad" && "border-bad/30 bg-bad-soft text-bad",
              t.tone === "info" && "border-line-strong bg-overlay text-ink",
              t.tone === "warn" && "border-warn/30 bg-warn-soft text-warn",
            )}
          >
            {t.tone === "good" ? <Check size={14} className="mt-0.5 shrink-0" /> : null}
            {t.tone === "bad" ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> : null}
            {t.tone === "info" ? <Info size={14} className="mt-0.5 shrink-0" /> : null}
            {t.tone === "warn" ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> : null}
            <span className="leading-snug">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ----------------------------------- misc ----------------------------------- */

export function KeyValue({
  items,
  rows,
}: {
  items?: { k: string; v: React.ReactNode }[];
  rows?: { label: string; value: React.ReactNode; mono?: boolean }[];
}) {
  const list = items ?? (rows ?? []).map((r) => ({ k: r.label, v: r.mono ? <span className="font-mono text-[11.5px]">{r.value}</span> : r.value }));
  const items_ = list;
  return (
    <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
      {items_.map((it) => (
        <div key={it.k} className="flex items-baseline justify-between gap-3 border-b border-line/60 py-1.5">
          <dt className="text-[11.5px] text-ink-faint">{it.k}</dt>
          <dd className="truncate text-right text-[12px] text-ink-dim">{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ConfirmButton({
  onConfirm,
  label,
  children,
  confirmLabel = "Confirm",
  question,
  variant = "danger",
  size = "sm",
  icon,
}: {
  onConfirm: () => void | Promise<void>;
  label?: string;
  children?: React.ReactNode;
  confirmLabel?: string;
  question?: string;
  title?: string;
  body?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  icon?: React.ComponentType<{ size?: number; className?: string }>;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      variant={armed ? "danger" : variant}
      size={size}
      icon={icon}
      loading={busy}
      onClick={async () => {
        if (!armed) return setArmed(true);
        setBusy(true);
        try {
          await onConfirm();
        } finally {
          setBusy(false);
          setArmed(false);
        }
      }}
    >
      {armed ? confirmLabel : (label ?? children)}
    </Button>
  );
}

export function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-[7px] border border-line bg-canvas px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-ink-dim",
        className,
      )}
    >
      {children}
    </pre>
  );
}

/* ------------------------------ console aliases -----------------------------
   Thin aliases so screens read the way operators talk: a drawer is a modal docked
   to the side, a toggle is a switch without the labelling row, a password input is
   an input that never renders its value in clear text.
   ponytail: no reveal-eye; add when operators ask for it. */

export function Drawer(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  return <Modal {...props} width={props.width ?? "max-w-xl"} />;
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[16px] w-[29px] shrink-0 rounded-full border transition-colors disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-line-strong bg-raised",
      )}
    >
      <span className={cn("absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white transition-all", checked ? "left-[15px]" : "left-[2px]")} />
    </button>
  );
}

export function PasswordInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input {...rest} type="password" autoComplete="off" spellCheck={false} className={cn(controlCls, "h-8 font-mono text-[12px]", className)} />;
}
