"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";

/**
 * Compact "topology aperture" for the tray popover — a miniature of the
 * dashboard's provider topology (usage page): the 9Router core in the middle,
 * provider dots on a ring around it, and glowing beams on whichever providers
 * have in-flight requests (active) / the last request (amber) / an error (red).
 *
 * Deliberately hand-rolled SVG instead of React Flow: the popover is small and
 * stays mounted in the background, so it must stay cheap. The beam animations
 * reuse the topology-* keyframes from globals.css.
 */

const CENTER_X = 160;
const CENTER_Y = 74;
const RING_RX = 126;
const RING_RY = 50;
const DOT_R = 10;
const CORE_R = 17;
// Dots before the ring switches to "…+N" — more than this is unreadable at
// popover scale anyway.
const MAX_DOTS = 13;

// Shared default so callers may omit `activeSet` without breaking memo deps.
const EMPTY_SET = new Set();

// Scoped styles, injected by the component instead of living in globals.css:
// the whole quota-panel is fork-only, so keeping every byte of this feature
// inside quota-panel/ leaves zero upstream-merge surface. Beam animations
// reuse the upstream topology-* keyframes from globals.css.
const APERTURE_CSS = `
@keyframes aperture-core-glow {
  0%, 100% {
    filter: drop-shadow(0 0 3px #fde047) drop-shadow(0 0 8px rgba(34, 211, 238, 0.45));
  }
  50% {
    filter: drop-shadow(0 0 6px #facc15) drop-shadow(0 0 14px rgba(34, 211, 238, 0.7));
  }
}
.aperture-core-active {
  animation: aperture-core-glow 0.9s ease-in-out infinite;
}
.aperture-core-badge {
  filter: drop-shadow(0 0 6px #fde047);
}
@keyframes aperture-ping {
  0% { transform: scale(1); opacity: 0.65; }
  80%, 100% { transform: scale(2.3); opacity: 0; }
}
.aperture-ping {
  transform-box: fill-box;
  transform-origin: center;
  animation: aperture-ping 1.4s cubic-bezier(0, 0, 0.2, 1) infinite;
}
`;

const STATE_BEAM = {
  active: null, // rendered by <ActiveBeam> (multi-layer)
  last: { stroke: "#f59e0b", width: 1.5, dash: "3 4", opacity: 0.6 },
  error: { stroke: "#ef4444", width: 1.5, dash: null, opacity: 0.75 },
  idle: { stroke: "var(--color-border)", width: 1, dash: null, opacity: 0.25 },
};

function stateFor(providerKey, activeSet, lastProvider, errorProvider) {
  if (activeSet.has(providerKey)) return "active";
  if (errorProvider && providerKey === errorProvider) return "error";
  if (lastProvider && providerKey === lastProvider) return "last";
  return "idle";
}

/** Beam from the core's rim to the dot's rim, in the given state. */
function Beam({ x1, y1, x2, y2, state, color }) {
  if (state === "active") {
    return (
      <g>
        {/* Electric halo (flicker) — same recipe as the dashboard beams */}
        <line
          x1={x1} y1={y1} x2={x2} y2={y2}
          stroke="#22d3ee" strokeWidth={7} strokeOpacity={0.3} strokeLinecap="round"
          className="topology-edge-halo"
        />
        {/* Provider-colored plasma */}
        <line
          x1={x1} y1={y1} x2={x2} y2={y2}
          stroke={color} strokeWidth={3} strokeOpacity={0.8} strokeLinecap="round"
        />
        {/* Hot white core (flowing dash) */}
        <line
          x1={x1} y1={y1} x2={x2} y2={y2}
          stroke="#f8fafc" strokeWidth={1.6} strokeLinecap="round"
          className="topology-edge-kame"
        />
      </g>
    );
  }
  const cfg = STATE_BEAM[state] || STATE_BEAM.idle;
  return (
    <line
      x1={x1} y1={y1} x2={x2} y2={y2}
      stroke={cfg.stroke} strokeWidth={cfg.width} strokeOpacity={cfg.opacity}
      strokeDasharray={cfg.dash || undefined} strokeLinecap="round"
    />
  );
}

Beam.propTypes = {
  x1: PropTypes.number.isRequired,
  y1: PropTypes.number.isRequired,
  x2: PropTypes.number.isRequired,
  y2: PropTypes.number.isRequired,
  state: PropTypes.oneOf(["active", "last", "error", "idle"]).isRequired,
  color: PropTypes.string.isRequired,
};

/** Provider dot: colored disc + provider icon, glow/ping when in use. */
function ApertureDot({ provider, color, x, y, state, label, onClick }) {
  const [imgError, setImgError] = useState(false);
  const iconSrc = getProviderIconSrc(provider);
  const active = state === "active";
  const ringColor = state === "error" ? "#ef4444" : state === "last" ? "#f59e0b" : color;

  const stateTitle =
    state === "active" ? "in use now" : state === "last" ? "last request" : state === "error" ? "recent error" : "idle";

  return (
    <g
      transform={`translate(${x} ${y})`}
      className={onClick ? "cursor-pointer" : undefined}
      onClick={onClick ? () => onClick(provider) : undefined}
    >
      <title>{`${label} — ${stateTitle}`}</title>
      {active ? <circle r={DOT_R} fill={color} className="aperture-ping" /> : null}
      <circle
        r={DOT_R}
        fill={`${color}22`}
        stroke={ringColor}
        strokeWidth={active ? 2 : 1.25}
        strokeDasharray={state === "last" ? "2.5 2" : undefined}
        strokeOpacity={state === "idle" ? 0.45 : 1}
        style={active ? { filter: `drop-shadow(0 0 5px ${color})` } : undefined}
      />
      {iconSrc && !imgError ? (
        <image
          href={iconSrc}
          x={-(DOT_R - 2)}
          y={-(DOT_R - 2)}
          width={(DOT_R - 2) * 2}
          height={(DOT_R - 2) * 2}
          opacity={state === "idle" ? 0.55 : 1}
          onError={() => {
            const m = iconSrc?.match(/^\/providers\/([^/]+)\.png$/i);
            if (m) markProviderIconMissing(m[1]);
            setImgError(true);
          }}
        />
      ) : (
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="7.5"
          fontWeight="700"
          fill={ringColor}
          opacity={state === "idle" ? 0.6 : 1}
        >
          {(provider || "?").slice(0, 2).toUpperCase()}
        </text>
      )}
    </g>
  );
}

ApertureDot.propTypes = {
  provider: PropTypes.string.isRequired,
  color: PropTypes.string.isRequired,
  x: PropTypes.number.isRequired,
  y: PropTypes.number.isRequired,
  state: PropTypes.oneOf(["active", "last", "error", "idle"]).isRequired,
  label: PropTypes.string.isRequired,
  onClick: PropTypes.func,
};

/**
 * @param {Array}  providers  [{ provider, label, color }] in list order
 * @param {Set}    activeSet  lowercase provider keys with in-flight requests
 * @param {string} lastProvider lowercase key of the most recent request
 * @param {string} errorProvider lowercase key of the most recent error
 * @param {number} activeCount total in-flight requests (core badge)
 * @param {func}   onSelect    (provider) => void, dot click
 */
export default function TopologyAperture({
  providers = [],
  activeSet,
  lastProvider = "",
  errorProvider = "",
  activeCount = 0,
  onSelect,
}) {
  const activeKeySet = activeSet || EMPTY_SET;
  const powering = activeCount > 0;

  const dots = useMemo(() => {
    const count = providers.length;
    if (count === 0) return [];
    const shown = Math.min(count, MAX_DOTS);
    const out = [];
    for (let i = 0; i < shown; i += 1) {
      const p = providers[i];
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
      out.push({
        ...p,
        x: CENTER_X + RING_RX * Math.cos(angle),
        y: CENTER_Y + RING_RY * Math.sin(angle),
        state: stateFor((p.provider || "").toLowerCase(), activeKeySet, lastProvider, errorProvider),
      });
    }
    return out;
  }, [providers, activeKeySet, lastProvider, errorProvider]);

  const overflow = providers.length - dots.length;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: APERTURE_CSS }} />
      <svg viewBox="0 0 320 148" className="w-full select-none" role="img" aria-label="Provider topology">
      {/* Ring guide */}
      <ellipse
        cx={CENTER_X} cy={CENTER_Y} rx={RING_RX} ry={RING_RY}
        fill="none"
        stroke="var(--color-border)"
        strokeOpacity={0.35}
        strokeDasharray="1 5"
      />

      {/* Beams under the dots */}
      {dots.map((d) => {
        const dx = d.x - CENTER_X;
        const dy = d.y - CENTER_Y;
        const len = Math.hypot(dx, dy) || 1;
        return (
          <Beam
            key={`beam-${d.provider}`}
            x1={CENTER_X + (dx / len) * (CORE_R + 3)}
            y1={CENTER_Y + (dy / len) * (CORE_R + 3)}
            x2={d.x - (dx / len) * (DOT_R + 3)}
            y2={d.y - (dy / len) * (DOT_R + 3)}
            state={d.state}
            color={d.color}
          />
        );
      })}

      {/* 9Router core */}
      <g>
        <title>{powering ? `9Router — ${activeCount} request${activeCount > 1 ? "s" : ""} in flight` : "9Router — idle"}</title>
        {powering ? (
          <circle
            cx={CENTER_X} cy={CENTER_Y} r={CORE_R + 5}
            fill="none" stroke="#fde047" strokeOpacity={0.35}
            className="aperture-ping"
          />
        ) : null}
        <circle
          cx={CENTER_X} cy={CENTER_Y} r={CORE_R}
          fill="var(--color-surface)"
          stroke={powering ? "#fde047" : "var(--color-primary)"}
          strokeWidth={1.5}
          className={powering ? "aperture-core-active" : undefined}
        />
        <image
          href="/favicon.svg"
          x={CENTER_X - 9} y={CENTER_Y - 9} width={18} height={18}
        />
        {powering ? (
          <g transform={`translate(${CENTER_X + CORE_R - 1} ${CENTER_Y + CORE_R - 1})`}>
            <circle r={7} fill="#fde047" className="aperture-core-badge" />
            <text textAnchor="middle" dominantBaseline="central" fontSize="8.5" fontWeight="700" fill="#111">
              {activeCount > 9 ? "9+" : activeCount}
            </text>
          </g>
        ) : null}
      </g>

      {/* Provider dots */}
      {dots.map((d) => (
        <ApertureDot
          key={`dot-${d.provider}`}
          provider={d.provider}
          color={d.color}
          x={d.x}
          y={d.y}
          state={d.state}
          label={d.label}
          onClick={onSelect}
        />
      ))}

      {/* Overflow chip */}
      {overflow > 0 ? (
        <g
          transform={`translate(${CENTER_X - RING_RX} ${CENTER_Y})`}
          className={onSelect ? "cursor-pointer" : undefined}
        >
          <title>{`${overflow} more providers`}</title>
          <circle r={DOT_R} fill="var(--color-surface)" stroke="var(--color-border)" />
          <text textAnchor="middle" dominantBaseline="central" fontSize="8" fontWeight="600" fill="var(--color-text-muted)">
            +{overflow}
          </text>
        </g>
      ) : null}

      {providers.length === 0 ? (
        <text
          textAnchor="middle"
          x={CENTER_X}
          y={CENTER_Y + RING_RY + 14}
          fontSize="9"
          fill="var(--color-text-muted)"
        >
          No providers connected
        </text>
      ) : null}
      </svg>
    </>
  );
}

TopologyAperture.propTypes = {
  providers: PropTypes.arrayOf(
    PropTypes.shape({
      provider: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      color: PropTypes.string.isRequired,
    }),
  ),
  activeSet: PropTypes.instanceOf(Set),
  lastProvider: PropTypes.string,
  errorProvider: PropTypes.string,
  activeCount: PropTypes.number,
  onSelect: PropTypes.func,
};
