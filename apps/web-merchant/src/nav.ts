import type { NavItem } from "@fintech-network/design-system";

// Which features are live is decided here. As a phase ships, flip its
// `disabled` flag and point it at the new screen — nothing else moves.
export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Till", icon: "home" },
  { to: "/takings", label: "Takings", icon: "activity" },
  { to: "/team", label: "Team", icon: "user" },
  { to: "/shop", label: "Shop", icon: "receipt" },
];
