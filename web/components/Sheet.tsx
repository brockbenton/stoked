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
  returnFocusTo,
}: {
  fromName: string;
  onClose: () => void;
  children: ReactNode;
  labelledBy: string;
  /** Element ids to try, in order, on close if the opener is gone. */
  returnFocusTo?: string[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Keep the latest callbacks without re-running the mount effect (which would steal focus).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const fallbackRef = useRef(returnFocusTo);
  fallbackRef.current = returnFocusTo;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
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
      // The opener may be gone (the wrapped card becomes the opened card); fall back.
      // Passive-effect cleanup runs after the commit, so the fallback is already in the DOM.
      if (prev && prev !== document.body && prev.isConnected) return prev.focus();
      for (const fid of fallbackRef.current ?? []) {
        const el = document.getElementById(fid);
        if (el) return el.focus();
      }
    };
  }, []);

  return (
    <div className="scrim">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref} tabIndex={-1}>
        <div className="sheet__handle" aria-hidden="true" />
        <div className="sheet__head">
          <span className="avatar avatar--gold" aria-hidden="true">
            {initials(fromName)}
          </span>
          <span className="sheet__from">From {fromName}</span>
          <button type="button" className="icon-btn" onClick={() => onCloseRef.current()} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
      </div>
    </div>
  );
}
