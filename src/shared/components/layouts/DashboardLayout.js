"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { useNotificationStore } from "@/store/notificationStore";
import Sidebar from "../Sidebar";
import Header from "../Header";
import CloseConfirmModal, { getRememberedCloseAction } from "../CloseConfirmModal";

function getToastStyle(type) {
  if (type === "success") {
    return {
      wrapper: "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400",
      icon: "check_circle",
    };
  }
  if (type === "error") {
    return {
      wrapper: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
      icon: "error",
    };
  }
  if (type === "warning") {
    return {
      wrapper: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      icon: "warning",
    };
  }
  return {
    wrapper: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
    icon: "info",
  };
}

export default function DashboardLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const pathname = usePathname();
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);

  // Tauri desktop shell: intercept the window close (red) button.
  // The Rust side prevent_default()s the close and emits "close-requested";
  // here we show the Quit / Minimize-to-tray dialog instead.
  useEffect(() => {
    let unlisten;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { listen, emit } = await import("@tauri-apps/api/event");
        const win = getCurrentWindow();
        unlisten = await listen("close-requested", async () => {
          const remembered = getRememberedCloseAction();
          if (remembered === "quit") {
            await win.destroy();
          } else if (remembered === "background") {
            // Emit "hide-to-tray" so Rust hides both window + Dock icon.
            // Can't use win.hide() directly because it doesn't hide Dock.
            // Can't use invoke("hide_to_tray") because custom commands are
            // blocked by ACL on remote URLs. Events work fine.
            await emit("hide-to-tray");
          } else {
            setCloseOpen(true);
          }
        });
      } catch {
        /* not in Tauri - browser keeps default close behavior */
      }
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  const handleCloseConfirm = async (action) => {
    setCloseOpen(false);
    try {
      if (action === "quit") {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().destroy();
      } else {
        const { emit } = await import("@tauri-apps/api/event");
        await emit("hide-to-tray");
      }
    } catch {
      /* not in Tauri */
    }
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-bg">
      <div className="fixed top-4 right-4 z-[80] flex w-[min(92vw,380px)] flex-col gap-2">
        {notifications.map((n) => {
          const style = getToastStyle(n.type);
          return (
            <div
              key={n.id}
              className={`rounded-lg border px-3 py-2 shadow-lg backdrop-blur-sm ${style.wrapper}`}
            >
              <div className="flex items-start gap-2">
                <span className="material-symbols-outlined text-[18px] leading-5">{style.icon}</span>
                <div className="min-w-0 flex-1">
                  {n.title ? <p className="text-xs font-semibold mb-0.5">{n.title}</p> : null}
                  <p className="text-xs whitespace-pre-wrap break-words">{n.message}</p>
                </div>
                {n.dismissible ? (
                  <button
                    type="button"
                    onClick={() => removeNotification(n.id)}
                    className="text-current/70 hover:text-current"
                    aria-label="Dismiss notification"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - Desktop */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {/* Sidebar - Mobile */}
      <div
        className={`fixed inset-y-0 left-0 z-50 transform lg:hidden transition-transform duration-300 ease-in-out ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar onClose={() => setSidebarOpen(false)} />
      </div>

      {/* Main content */}
      <main className="flex flex-col flex-1 h-full min-w-0 relative transition-colors duration-300 isolate">
        {/* Faint grid background */}
        <div className="landing-grid absolute inset-0 pointer-events-none -z-10" aria-hidden="true" />
        <Header key={pathname} onMenuClick={() => setSidebarOpen(true)} />
        <div className={`flex-1 overflow-y-auto custom-scrollbar ${pathname === "/dashboard/basic-chat" ? "" : "p-6 lg:p-10"} ${pathname === "/dashboard/basic-chat" ? "flex flex-col overflow-hidden" : ""}`}>
          <div className={`${pathname === "/dashboard/basic-chat" ? "flex-1 w-full h-full flex flex-col" : "max-w-7xl mx-auto"}`}>{children}</div>
        </div>
      </main>

      {/* Close confirmation (Tauri desktop shell only) */}
      <CloseConfirmModal
        isOpen={closeOpen}
        onClose={() => setCloseOpen(false)}
        onConfirm={handleCloseConfirm}
      />
    </div>
  );
}
