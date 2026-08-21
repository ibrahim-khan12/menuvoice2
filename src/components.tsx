// Shared accessible web UI primitives. Buttons/inputs are >= 64px,
// have roles/labels, and a visible focus ring (see index.css :focus-visible).

import React, { useLayoutEffect, useRef, useState } from 'react';

export function Screen({ children, label, className }: { children: React.ReactNode; label?: string; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    // Move focus before paint so screen readers do not first announce a stale
    // control from the previous route. A concise label prevents VoiceOver from
    // treating a newly focused main landmark as a request to read every child.
    ref.current?.focus();
  }, []);
  return (
    <main id="main-content" className={`screen${className ? ` ${className}` : ''}`} tabIndex={-1} ref={ref} aria-label={label}>
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

// ── Allergen review panel ───────────────────────────────────────────────────
// Shown whenever saving allergies would require changing or guessing at what
// the user said. One question per word; nothing is saved until every question
// is answered. This keeps a safety-critical field consensual: the app suggests,
// the user decides.
export interface AllergenQuestion {
  typed: string;
  suggested?: string; // present = spelling suggestion; absent = unrecognized word
}

export function AllergenReviewPanel({
  questions,
  onDone,
  onRetype,
}: {
  questions: AllergenQuestion[];
  onDone: (kept: string[]) => void;
  // Removing a word we don't recognize is not a decision to move on: the user
  // most likely mistyped it. When provided, removal hands the word back so the
  // caller can return to the allergy field for a correction.
  onRetype?: (removed: string) => void;
}) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const keptRef = useRef<string[]>([]);
  const promptRef = useRef<HTMLParagraphElement>(null);
  const question = questions[questionIndex];

  useLayoutEffect(() => {
    promptRef.current?.focus();
  }, [questionIndex]);

  const decide = (value: string | null) => {
    const kept = value ? [...keptRef.current, value] : keptRef.current;
    keptRef.current = kept;
    if (questionIndex === questions.length - 1) {
      onDone(kept);
      return;
    }
    setQuestionIndex((current) => current + 1);
  };

  if (!question) return null;

  return (
    <div className="card" role="group" aria-label="Check your allergy list before saving">
      <div className="allergen-question">
        <p className="body" style={{ marginBottom: 10 }} ref={promptRef} tabIndex={-1}>
          {questions.length > 1 && `Question ${questionIndex + 1} of ${questions.length}. `}
          {question.suggested ? (
            <>
              You entered <strong>{question.typed}</strong>. Did you mean{' '}
              <strong>{question.suggested}</strong>?
            </>
          ) : (
            <>
              Watch for <strong>{question.typed}</strong>?
            </>
          )}
        </p>
        <div className="row">
          <button
            className="btn btn-primary"
            style={{ flex: 1, minHeight: 56 }}
            onClick={() => decide(question.suggested ?? question.typed)}
            aria-label={
              question.suggested
                ? `Yes, save ${question.suggested}`
                : `Keep ${question.typed} on my allergy list`
            }
          >
            {question.suggested ? `Yes, ${question.suggested}` : 'Keep it'}
          </button>
          <button
            className="btn btn-secondary"
            style={{ flex: 1, minHeight: 56 }}
            onClick={() => {
              if (!question.suggested && onRetype) {
                onRetype(question.typed);
                return;
              }
              decide(question.suggested ? question.typed : null);
            }}
            aria-label={
              question.suggested
                ? `No, keep ${question.typed} exactly as I entered it`
                : onRetype
                  ? `Remove ${question.typed} and go back to type it again`
                  : `Remove ${question.typed} from my allergy list`
            }
          >
            {question.suggested
              ? `Keep "${question.typed}"`
              : onRetype
                ? 'Remove and retype'
                : 'Remove it'}
          </button>
        </div>
      </div>
    </div>
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
