"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { initials } from "@/lib/format";
import { CloseIcon } from "./icons";

/** Bottom sheet over the page (03a/03b). Escape and the close button dismiss it. */
export function Sheet({
  fromName,
  onClose,
  children,
  labelledBy,
}: {
  fromName: string;
  onClose: () => void;
  children: ReactNode;
  labelledBy: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && ref.current) {
        const items = ref.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), textarea, [tabindex="0"]',
        );
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="scrim">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref} tabIndex={-1}>
        <div className="sheet__handle" aria-hidden="true" />
        <div className="sheet__head">
          <span className="avatar avatar--gold" aria-hidden="true">
            {initials(fromName)}
          </span>
          <span className="sheet__from">From {fromName}</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
      </div>
    </div>
  );
}
