import React, { useEffect } from "react";

interface Props {
  message: string;
  type: string;
  onDismiss: () => void;
}

export function Notification({ message, type, onDismiss }: Props) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  return <div className={`notification ${type} show`}>{message}</div>;
}
