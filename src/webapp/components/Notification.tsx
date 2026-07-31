import React, { useEffect, useRef } from "react";

interface Props {
  message: string;
  type: string;
  onDismiss: () => void;
}

export function Notification({ message, type, onDismiss }: Props) {
  // Hold onDismiss in a ref so the auto-dismiss timer is keyed on the message
  // alone. Callers commonly pass a fresh inline arrow each render, which
  // previously restarted the 4s timer on every App re-render — a notification
  // raised while the operator was typing never dismissed itself.
  const onDismissRef = useRef(onDismiss);

  // Assigned in an effect rather than during render: a render may be discarded
  // or replayed, and mutating a ref on that path would hand the timer below a
  // callback from a render that never committed. No dependency array, so it
  // runs after every commit — and effects run in declaration order, so the
  // timer effect always sees the current callback.
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    const timer = setTimeout(() => onDismissRef.current(), 4000);
    return () => clearTimeout(timer);
  }, [message]);

  return (
    // role=status + aria-live so save results and auth errors are announced;
    // as a bare div they were invisible to screen readers. "assertive" for
    // errors so a failure interrupts rather than queueing behind other output.
    <div
      className={`notification ${type} show`}
      role={type === "error" ? "alert" : "status"}
      aria-live={type === "error" ? "assertive" : "polite"}
    >
      {message}
    </div>
  );
}
