// Shared accessible web UI primitives. Buttons/inputs are >= 64px,
// have roles/labels, and a visible focus ring (see index.css :focus-visible).

import React, { useEffect, useRef } from 'react';

export function Screen({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    // Move focus to screen top on every mount so keyboard/SR users land at content
    ref.current?.focus();
  }, []);
  return (
    <main id="main-content" className="screen" tabIndex={-1} ref={ref}>
      {children}
    </main>
  );
}

export function Title({ children }: { children: React.ReactNode }) {
  return <h1 className="title">{children}</h1>;
}

export function Subtitle({ children }: { children: React.ReactNode }) {
  return <p className="subtitle">{children}</p>;
}

export function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="heading">{children}</h2>;
}

export function Body({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <p className="body" style={style}>
      {children}
    </p>
  );
}

interface BtnProps {
  label: string;
  onClick: () => void;
  hint?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  className?: string;
}

export function PrimaryButton({ label, onClick, hint, disabled, style, className }: BtnProps) {
  return (
    <button
      className={`btn btn-primary${className ? ` ${className}` : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={hint ? `${label}. ${hint}` : label}
      style={style}
    >
      {label}
    </button>
  );
}

export function SecondaryButton({
  label,
  onClick,
  hint,
  disabled,
  tone,
  style,
  className,
}: BtnProps & { tone?: 'default' | 'danger' }) {
  return (
    <button
      className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-secondary'}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={hint ? `${label}. ${hint}` : label}
      style={style}
    >
      {label}
    </button>
  );
}

export function TextField(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
}) {
  return (
    <input
      className="input"
      type="text"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      placeholder={props.placeholder}
      aria-label={props.label}
      autoFocus={props.autoFocus}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && props.onSubmit) props.onSubmit();
      }}
    />
  );
}
