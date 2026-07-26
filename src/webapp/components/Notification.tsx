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
  onDismissRef.current = onDismiss;

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
