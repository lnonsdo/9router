"use client";

import { useState } from "react";
import Button from "./Button";
import Modal from "./Modal";

const STORAGE_KEY = "9router-close-action";

// Shown when the user clicks the window close (red) button inside the Tauri
// desktop shell. Lets them choose Quit (stop server) or Minimize to tray
// (keep server running, reopen from tray icon). Choice can be remembered.
export default function CloseConfirmModal({ isOpen, onClose, onConfirm }) {
  const [remember, setRemember] = useState(false);

  const handleConfirm = (action) => {
    if (remember) {
      try { localStorage.setItem(STORAGE_KEY, action); } catch { /* ignore */ }
    }
    onConfirm(action);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      showTrafficLights={false}
      size="sm"
      title="Close 9Router"
      footer={
        <>
          <Button variant="secondary" onClick={() => handleConfirm("background")}>
            Minimize to tray
          </Button>
          <Button variant="danger" onClick={() => handleConfirm("quit")}>
            Quit
          </Button>
        </>
      }
    >
      <p className="text-text-muted">
        Do you want to quit the app (stop the proxy server) or keep it running in the background?
      </p>
      <label className="flex items-center gap-2 mt-3 text-xs text-text-muted cursor-pointer select-none">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="rounded border-border-subtle"
        />
        Remember my choice
      </label>
    </Modal>
  );
}

// Read the remembered action (called on close-request).
export function getRememberedCloseAction() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

// Clear the remembered action (e.g. from Settings).
export function clearRememberedCloseAction() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
