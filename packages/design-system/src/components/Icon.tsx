// A small inline icon set so the UI has no external asset dependency.
// All icons are 24x24 line icons using currentColor.
import type { SVGProps } from "react";

const paths = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  send: "M4 12h13M12 5l7 7-7 7",
  request: "M20 12H7M12 19l-7-7 7-7",
  scan: "M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10",
  split: "M12 3v6M12 9l-6 6v6M12 9l6 6v6",
  activity: "M4 6h16M4 12h16M4 18h10",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  back: "M15 5l-7 7 7 7",
  check: "M5 12.5l4.5 4.5L19 7",
  close: "M6 6l12 12M18 6 6 18",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  alert: "M12 8v5M12 16.5v.5M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  info: "M12 11v6M12 7.5v.5M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  leaf: "M5 19c0-8 5-14 15-15-1 10-7 15-15 15zM5 19l7-7",
  chevron: "M9 5l7 7-7 7",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  ask: "M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1zM9 10h6",
} as const;

export type IconName = keyof typeof paths;

export interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
  /** Omit for decorative icons (the default); pass a label if the icon alone carries meaning. */
  label?: string;
}

export function Icon({ name, size = 24, label, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}
