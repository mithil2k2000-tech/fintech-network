// Design system entry point (spec §20). Apps import components and money
// helpers from here, plus "@fintech-network/design-system/styles.css" once.
export { formatMoney, parseMoneyInput } from "./money";
export type { FormatMoneyOptions, ParseMoneyResult } from "./money";

export { Icon } from "./components/Icon";
export type { IconName } from "./components/Icon";
export { Button, ButtonLink } from "./components/Button";
export type { ButtonVariant } from "./components/Button";
export {
  Alert,
  Badge,
  EmptyState,
  PageLoader,
  ResultIcon,
  Skeleton,
  Spinner,
} from "./components/Feedback";
export type { Tone, BadgeTone } from "./components/Feedback";
export { AmountField, Checkbox, SegmentedControl, TextField } from "./components/Form";
export {
  ActionTiles,
  AppShell,
  BottomNav,
  BrandMark,
  Card,
  SectionTitle,
} from "./components/Layout";
export type { NavItem, ActionTileProps } from "./components/Layout";
export {
  AmountSummary,
  Avatar,
  BalanceCard,
  DetailList,
  TransactionRow,
} from "./components/Money";
export type { DetailRow } from "./components/Money";
