import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import type { SessionUser } from "../roles";
import { ThemeSwitch } from "../theme/ThemeSwitch";
import {
  activeTabId,
  matchNavItem,
  tabHref,
  visibleGroupsFor,
  visibleTabsFor,
  type NavGroup,
  type NavTab,
} from "./nav";

function HeaderBar({ user }: { user: SessionUser | null }) {
  return (
    <header className="app-header">
      <div className="app-brand">應用語意防禦</div>
      <p className="mode-pill">模式：尚未接線</p>
      <div className="app-header__right">
        <div data-testid="theme-slot-topbar">
          <ThemeSwitch />
        </div>
        {user ? <span>{user.username}</span> : null}
      </div>
    </header>
  );
}

function TabBar(props: {
  tabs: NavTab[];
  activeId: string | undefined;
  user: SessionUser | null;
}) {
  return (
    <nav className="app-tabs" aria-label="主要分區">
      {props.tabs.map((tab) => {
        const href = tabHref(tab.id, props.user);
        if (!href) return null;
        const current = tab.id === props.activeId;
        return (
          <Link
            key={tab.id}
            to={href}
            className={current ? "app-tab app-tab--on" : "app-tab"}
            aria-current={current ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

function GroupLinks(props: { group: NavGroup; activePath: string | undefined }) {
  return (
    <div>
      <div className="app-tree__group">{props.group.label}</div>
      {props.group.items.map((item) => {
        const current = item.path === props.activePath;
        return (
          <Link
            key={item.path}
            to={item.path}
            className={current ? "app-tree__item app-tree__item--on" : "app-tree__item"}
            aria-current={current ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}

function SideTree(props: {
  groups: NavGroup[];
  activePath: string | undefined;
}) {
  return (
    <nav className="app-tree" aria-label="本區頁面">
      {props.groups.map((group) => (
        <GroupLinks key={group.label} group={group} activePath={props.activePath} />
      ))}
      <div className="app-sidebar" data-testid="theme-slot-sidebar">
        <ThemeSwitch />
      </div>
    </nav>
  );
}

export function AiLaunchButton() {
  const [open, setOpen] = useState(false);
  return (
    <div className="ai-launch-wrap">
      <button
        type="button"
        className="ai-launch"
        data-testid="ai-launch"
        onClick={() => setOpen(true)}
      >
        詢問 AI
      </button>
      {open ? (
        <p role="status" data-testid="ai-launch-status">
          AI 尚未啟用
        </p>
      ) : null}
    </div>
  );
}

export function AppChrome() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const tabs = visibleTabsFor(user);
  const activeId = activeTabId(pathname, user);
  const groups = activeId ? visibleGroupsFor(activeId, user) : [];
  const activePath = matchNavItem(pathname);
  return (
    <div className="app-chrome has-fab">
      <HeaderBar user={user} />
      <TabBar tabs={tabs} activeId={activeId} user={user} />
      <div className="app-chrome__body">
        <SideTree groups={groups} activePath={activePath} />
        <div className="app-chrome__main">
          <Outlet />
          <div
            className="ai-launch-spacer"
            data-testid="ai-launch-spacer"
            aria-hidden="true"
          />
        </div>
      </div>
      <AiLaunchButton />
    </div>
  );
}
