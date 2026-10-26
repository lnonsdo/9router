"use client";

import { getRememberedCloseAction } from "@/shared/components/CloseConfirmModal";
import { destroyCurrentWindow, emitDesktop, listenDesktop } from "./index";

/**
 * Desktop close flow: the Rust shell intercepts the red close button and
 * emits "close-requested"; this module replays the remembered close action
 * (quit / minimize-to-tray) or asks the caller to show the confirm dialog.
 *
 * Returns an unlisten function.
 */
export function registerCloseConfirm(onNeedConfirm) {
  return listenDesktop("close-requested", async () => {
    const remembered = getRememberedCloseAction();
    if (remembered === "quit") {
      await destroyCurrentWindow();
    } else if (remembered === "background") {
      // Rust hides both the window and the Dock icon: win.hide() alone cannot
      // hide the Dock, and custom commands are blocked by the ACL on remote URLs.
      await emitDesktop("hide-to-tray");
    } else {
      onNeedConfirm?.();
    }
  });
}

/** Confirm-dialog action: quit the app. */
export function confirmQuit() {
  return destroyCurrentWindow();
}

/** Confirm-dialog action: hide the window + Dock icon (stay in tray). */
export function confirmMinimizeToTray() {
  return emitDesktop("hide-to-tray");
}
