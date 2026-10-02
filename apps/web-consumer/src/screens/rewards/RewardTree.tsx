// The tree itself, drawn from the numbers the server sent.
//
// Inline SVG in currentColor and design-system tokens, so it reads in
// light and dark without a second asset. Nothing here decides anything:
// the stage and the leaf count arrive already worked out, and this only
// chooses what to draw for them.

interface RewardTreeProps {
  /** 0 (seed) upwards. */
  level: number;
  /** How many leaves to draw; the server caps this. */
  leaves: number;
  /** The stage's name, for people who can't see the drawing. */
  label: string;
}

/**
 * Leaf positions, in the order they appear. Fixed rather than random,
 * so the same tree looks the same every time it's opened.
 */
const LEAF_SPOTS: { x: number; y: number; r: number }[] = [
  { x: 60, y: 74, r: 11 },
  { x: 100, y: 70, r: 12 },
  { x: 80, y: 46, r: 11 },
  { x: 44, y: 98, r: 10 },
  { x: 116, y: 96, r: 10 },
  { x: 62, y: 38, r: 9 },
  { x: 98, y: 36, r: 9 },
  { x: 32, y: 74, r: 9 },
  { x: 128, y: 72, r: 9 },
  { x: 80, y: 24, r: 8 },
  { x: 48, y: 54, r: 8 },
  { x: 112, y: 54, r: 8 },
];

/** How tall the trunk has grown by this stage, as a fraction of the pot. */
const TRUNK_BY_LEVEL = [0, 18, 38, 62, 84, 100, 112];

export function RewardTree({ level, leaves, label }: RewardTreeProps) {
  const trunkHeight = TRUNK_BY_LEVEL[Math.min(level, TRUNK_BY_LEVEL.length - 1)];
  const groundY = 170;
  const trunkTop = groundY - trunkHeight;
  const canopy = Math.max(0, level - 1);
  const shownLeaves = level >= 2 ? LEAF_SPOTS.slice(0, leaves) : [];

  return (
    <svg
      viewBox="0 0 160 190"
      width="100%"
      height="220"
      role="img"
      aria-label={`Your rewards tree: ${label}`}
      style={{ display: "block", maxWidth: 260, margin: "0 auto" }}
    >
      {/* Ground */}
      <line
        x1="16"
        y1={groundY}
        x2="144"
        y2={groundY}
        stroke="var(--ds-border)"
        strokeWidth="3"
        strokeLinecap="round"
      />

      {level === 0 ? (
        // A seed, waiting.
        <ellipse cx="80" cy={groundY - 7} rx="9" ry="7" fill="var(--ds-accent)" opacity="0.5" />
      ) : (
        <>
          <line
            x1="80"
            y1={groundY}
            x2="80"
            y2={trunkTop}
            stroke="var(--ds-accent)"
            strokeWidth={level >= 4 ? 8 : level >= 2 ? 6 : 4}
            strokeLinecap="round"
          />
          {/* Branches arrive once there's a trunk to hang them on. */}
          {canopy >= 2 ? (
            <>
              <path
                d={`M80 ${trunkTop + 24} C 62 ${trunkTop + 18}, 52 ${trunkTop + 6}, 46 ${trunkTop - 6}`}
                stroke="var(--ds-accent)"
                strokeWidth="4"
                fill="none"
                strokeLinecap="round"
              />
              <path
                d={`M80 ${trunkTop + 30} C 98 ${trunkTop + 24}, 108 ${trunkTop + 12}, 114 ${trunkTop}`}
                stroke="var(--ds-accent)"
                strokeWidth="4"
                fill="none"
                strokeLinecap="round"
              />
            </>
          ) : null}

          {/* The canopy grows with the stage; leaves count the payments. */}
          {canopy >= 1 ? (
            <circle
              cx="80"
              cy={trunkTop - 6}
              r={18 + canopy * 8}
              fill="var(--ds-accent-soft)"
              stroke="var(--ds-accent)"
              strokeWidth="2"
            />
          ) : (
            // A sprout: two small leaves and nothing else.
            <>
              <ellipse cx="72" cy={trunkTop} rx="9" ry="5" fill="var(--ds-accent)" opacity="0.7" />
              <ellipse cx="88" cy={trunkTop - 4} rx="9" ry="5" fill="var(--ds-accent)" opacity="0.7" />
            </>
          )}

          {shownLeaves.map((leaf, i) => (
            <circle
              key={i}
              cx={leaf.x}
              cy={trunkTop - 6 - (80 - leaf.y) * 0.35}
              r={leaf.r * 0.5}
              fill="var(--ds-accent)"
              opacity="0.75"
            />
          ))}
        </>
      )}
    </svg>
  );
}
