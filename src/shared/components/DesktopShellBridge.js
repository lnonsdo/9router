"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import CloseConfirmModal from "@/shared/components/CloseConfirmModal";
import { listenDesktop } from "@/shared/services/desktop";
import {
  confirmMinimizeToTray,
  confirmQuit,
  registerCloseConfirm,
} from "@/shared/services/desktop/closeConfirm";

/**
 * Desktop-shell glue for the dashboard layout: the quit/minimize-to-tray
 * close dialog (the Rust shell intercepts the red close button) and
 * client-side routing requests from the usage panel. No-ops in the browser,
 * so the only upstream delta in the layout file is mounting this component.
 */
export default function DesktopShellBridge() {
  const [closeOpen, setCloseOpen] = useState(false);
  const router = useRouter();

  // The Rust side prevent_default()s the window close and emits
  // "close-requested"; the desktop service replays the remembered action or
  // opens the confirm dialog.
  useEffect(() => {
    let unlisten;
    let cancelled = false;
    registerCloseConfirm(() => setCloseOpen(true)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Usage panel's "Dashboard" row: the Rust shell brings this window back and
  // emits "navigate-dashboard"; route client-side (SPA) to avoid a full page
  // reload. Browser environments never receive this event.
  useEffect(() => {
    let unlisten;
    let cancelled = false;
    listenDesktop("navigate-dashboard", (event) => {
      const path = event?.payload?.path;
      if (path && typeof path === "string") router.push(path);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [router]);

  const handleCloseConfirm = async (action) => {
    setCloseOpen(false);
    try {
      if (action === "quit") {
        await confirmQuit();
      } else {
        await confirmMinimizeToTray();
      }
    } catch {
      /* not in Tauri */
    }
  };

  return (
    <CloseConfirmModal
      isOpen={closeOpen}
      onClose={() => setCloseOpen(false)}
      onConfirm={handleCloseConfirm}
    />
  );
}
