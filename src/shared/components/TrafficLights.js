"use client";

import { Tooltip } from "@/shared/components";

// Real macOS traffic lights backed by Tauri window APIs.
// Only active inside the Tauri desktop shell (where `@tauri-apps/api` exists);
// in a plain browser the buttons are hidden so the layout stays unchanged.
export default function TrafficLights() {
  const onClose = async () => {
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("close-requested");
    } catch {
      /* not in Tauri - ignore */
    }
  };
  const onMinimize = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch {
      /* not in Tauri — ignore */
    }
  };
  const onMaximize = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().toggleMaximize();
    } catch {
      /* not in Tauri — ignore */
    }
  };

  return (
    <div className="hidden md:flex items-center gap-2 px-6 pt-5 pb-2">
      <Tooltip text="Close" position="top" color="#FF5F56">
        <button
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className="w-3 h-3 rounded-full bg-[#FF5F56] hover:brightness-90 transition-all cursor-pointer flex items-center justify-center group/dot"
        >
          <span className="text-[9px] font-bold text-white opacity-0 group-hover/dot:opacity-100 transition-opacity leading-none">✕</span>
        </button>
      </Tooltip>
      <Tooltip text="Minimize" position="top" color="#FFBD2E">
        <button
          onClick={onMinimize}
          aria-label="Minimize"
          title="Minimize"
          className="w-3 h-3 rounded-full bg-[#FFBD2E] hover:brightness-90 transition-all cursor-pointer flex items-center justify-center group/dot"
        >
          <span className="text-[9px] font-bold text-white opacity-0 group-hover/dot:opacity-100 transition-opacity leading-none">–</span>
        </button>
      </Tooltip>
      <Tooltip text="Maximize" position="top" color="#27C93F">
        <button
          onClick={onMaximize}
          aria-label="Maximize"
          title="Maximize"
          className="w-3 h-3 rounded-full bg-[#27C93F] hover:brightness-90 transition-all cursor-pointer flex items-center justify-center group/dot"
        >
          <span className="text-[9px] font-bold text-white opacity-0 group-hover/dot:opacity-100 transition-opacity leading-none">+</span>
        </button>
      </Tooltip>
    </div>
  );
}
