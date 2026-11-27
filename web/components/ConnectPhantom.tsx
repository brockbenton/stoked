"use client";

import { useEffect, useState } from "react";
import { PHANTOM_DOWNLOAD, connectLink, type PhantomLink, type WalletMode } from "@/lib/client/phantom";

/**
 * "Connect Phantom": a button where Phantom is in this browser, a link into the
 * app on a phone, and otherwise a link to get it.
 */
export function ConnectPhantom({
  mode,
  onConnect,
  primary = true,
}: {
  mode: WalletMode;
  onConnect: () => void;
  primary?: boolean;
}) {
  const className = `btn ${primary ? "btn--primary" : "btn--secondary"}`;
  const [link, setLink] = useState<PhantomLink | null>(null);
  useEffect(() => {
    if (mode === "app") setLink(connectLink());
  }, [mode]);

  if (mode === "extension") {
    return (
      <button type="button" className={className} onClick={onConnect}>
        Connect Phantom
      </button>
    );
  }
  if (mode === "app") {
    return (
      <a className={className} href={link?.href} onClick={() => link?.arm()}>
        Connect Phantom
      </a>
    );
  }
  return (
    <a className={className} href={PHANTOM_DOWNLOAD} target="_blank" rel="noreferrer">
      Get Phantom
    </a>
  );
}
