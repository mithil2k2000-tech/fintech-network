import type { ActionTileProps, NavItem } from "@fintech-network/design-system";

// Which features are live is decided here. As a phase ships, flip its
// `disabled` flag and point it at the new screen — nothing else moves.
export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/pay", label: "Pay", icon: "send" },
  { to: "/activity", label: "Activity", icon: "activity" },
  { to: "/rewards", label: "Rewards", icon: "leaf" },
  { to: "/profile", label: "Profile", icon: "user" },
];

export const HOME_ACTIONS: ActionTileProps[] = [
  { to: "/pay", label: "Pay", icon: "send" },
  { to: "/request", label: "Request", icon: "request" },
  { to: "/scan", label: "Scan", icon: "scan" },
  { to: "/split", label: "Split", icon: "split" },
];
