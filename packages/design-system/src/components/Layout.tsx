import type { ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { Icon, type IconName } from "./Icon";

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Shown but not usable yet — keeps the layout stable as features land. */
  disabled?: boolean;
}

export function BottomNav({ items }: { items: NavItem[] }) {
  return (
    <nav className="ds-nav" aria-label="Main">
      <ul className="ds-nav__list">
        {items.map((item) => (
          <li key={item.to}>
            {item.disabled ? (
              <span className="ds-nav__link" aria-disabled="true">
                <Icon name={item.icon} />
                {item.label}
              </span>
            ) : (
              <NavLink to={item.to} end={item.to === "/"} className="ds-nav__link">
                <Icon name={item.icon} />
                {item.label}
              </NavLink>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface AppShellProps {
  title?: ReactNode;
  /** Where the back button goes; true = browser history. */
  back?: string | true;
  headerAction?: ReactNode;
  nav?: NavItem[];
  children: ReactNode;
}

export function AppShell({ title, back, headerAction, nav, children }: AppShellProps) {
  const navigate = useNavigate();
  const showHeader = title !== undefined || back !== undefined || headerAction !== undefined;
  return (
    <div className={`ds-shell${nav ? " ds-shell--with-nav" : ""}`}>
      {showHeader ? (
        <header className="ds-shell__header">
          {back !== undefined ? (
            <button
              type="button"
              className="ds-icon-button"
              aria-label="Back"
              onClick={() => (back === true ? navigate(-1) : navigate(back))}
            >
              <Icon name="back" />
            </button>
          ) : null}
          <h1 className="ds-shell__title">{title}</h1>
          {headerAction}
        </header>
      ) : null}
      <main className="ds-shell__main">{children}</main>
      {nav ? <BottomNav items={nav} /> : null}
    </div>
  );
}

export function Card({ children, flush }: { children: ReactNode; flush?: boolean }) {
  return <section className={`ds-card${flush ? " ds-card--flush" : ""}`}>{children}</section>;
}

export function SectionTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: { to: string; label: string };
}) {
  return (
    <h2 className="ds-section-title">
      <span>{children}</span>
      {action ? <Link to={action.to}>{action.label}</Link> : null}
    </h2>
  );
}

export function BrandMark({ name }: { name: string }) {
  return (
    <div className="ds-brand">
      <span className="ds-brand__mark" aria-hidden="true">
        <Icon name="shield" size={22} />
      </span>
      <span>{name}</span>
    </div>
  );
}

export interface ActionTileProps {
  to: string;
  label: string;
  icon: IconName;
  disabled?: boolean;
}

export function ActionTiles({ actions }: { actions: ActionTileProps[] }) {
  return (
    <div className="ds-actions">
      {actions.map((a) =>
        a.disabled ? (
          <span key={a.label} className="ds-action" aria-disabled="true">
            <span className="ds-action__icon">
              <Icon name={a.icon} />
            </span>
            {a.label}
            <span className="ds-action__soon">Soon</span>
          </span>
        ) : (
          <Link key={a.label} to={a.to} className="ds-action">
            <span className="ds-action__icon">
              <Icon name={a.icon} />
            </span>
            {a.label}
          </Link>
        )
      )}
    </div>
  );
}
