import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Alert,
  App as AntApp,
  Avatar,
  Breadcrumb,
  Button,
  Drawer,
  Dropdown,
  Form,
  Input,
  Menu,
  Result,
  Tooltip,
} from "antd";
import {
  Activity,
  ArrowRight,
  ChevronDown,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  Settings2,
} from "lucide-react";
import { api, setCsrf, validEntrance } from "./api";
import { ThemeSwitch } from "./theme";
import { LanguageSwitch } from "./i18n";
import { useTranslation } from "react-i18next";
import { navigate, useRoute } from "./navigation";
import { Loading, PageHeader } from "./ui";
import { BrandMark } from "./BrandMark";
import { PageLoadingFallback, PageTransition } from "./PageTransition";
import DeviceList from "./DeviceList";
import ConnectionHistory from "./ConnectionHistory";
import type { Device } from "./types";
const DeviceWorkspace = lazy(() => import("./DeviceWorkspace"));
const AuditView = lazy(() => import("./AuditView"));
const ClientConfig = lazy(() => import("./ClientConfig"));

export default function App() {
  return (
    <AntApp>
      <Session />
    </AntApp>
  );
}
function Session() {
  const { t, i18n } = useTranslation();
  const [session, setSession] = useState<"loading" | "guest" | "ready">(
    "loading",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    document.title = `Rust Remote · ${t("consoleSubtitle")}`;
    document.documentElement.lang = i18n.language.startsWith("en") ? "en" : "zh-CN";
  }, [t, i18n.language]);
  useEffect(() => {
    if (!validEntrance) {
      setSession("guest");
      return;
    }
    let active = true;
    api<{ csrf_token: string }>("/session")
      .then((data) => {
        if (active) {
          setCsrf(data.csrf_token);
          setSession("ready");
        }
      })
      .catch(() => {
        if (active) setSession("guest");
      });
    const expire = () => {
      setSession("guest");
      setCsrf("");
      setError(t("expired"));
    };
    window.addEventListener("session-expired", expire);
    return () => {
      active = false;
      window.removeEventListener("session-expired", expire);
    };
  }, []);
  async function login({ password }: { password: string }) {
    setBusy(true);
    setError("");
    try {
      const data = await api<{ csrf_token: string }>("/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setCsrf(data.csrf_token);
      setSession("ready");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    try {
      await api("/logout", { method: "POST" });
      setCsrf("");
      setError("");
      setSession("guest");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!validEntrance)
    return (
      <div className="login">
        <Result
          status="404"
          title={t("invalidEntry")}
          subTitle={t("invalidEntryHint")}
        />
      </div>
    );
  if (session === "loading")
    return (
      <div className="login">
        <Loading />
      </div>
    );
  if (session === "guest")
    return (
      <div className="login">
        <div className="login-theme">
          <LanguageSwitch />
          <ThemeSwitch />
        </div>
        <div className="login-shell">
          <main className="login-box">
          <div className="login-brand">
            <BrandMark />
            <span>
              Rust Remote<small>{t("appSubtitle")}</small>
            </span>
          </div>
          <section className="login-card">
            <div className="login-kicker"><LockKeyhole size={15} /> {t("login")}</div>
            <h1>{t("welcome")}</h1>
            <p className="muted">{t("loginHint")}</p>
            <Form
              layout="vertical"
              onFinish={login}
              requiredMark={false}
              size="large"
            >
              <Form.Item
                name="password"
                label={t("password")}
                rules={[{ required: true, message: t("passwordRequired") }]}
              >
                <Input.Password
                  prefix={<LockKeyhole size={16} />}
                  placeholder={t("passwordPlaceholder")}
                  autoComplete="current-password"
                  autoFocus
                />
              </Form.Item>
              {error && (
                <Alert
                  type="error"
                  showIcon
                  title={error}
                  className="form-alert"
                />
              )}
              <Button type="primary" htmlType="submit" loading={busy} block>
                {t("enterConsole")} <ArrowRight size={16} />
              </Button>
            </Form>
            <div className="login-foot">
              <ShieldCheck size={14} />
              {t("authorizedOnly")}
            </div>
          </section>
          <div className="login-copyright">Rust Remote · {t("remoteManagement")}</div>
          </main>
          <aside className="login-visual" aria-label={t("remoteManagementIntro")}>
            <div className="login-visual-top"><span>{t("remoteManagement")}</span><span className="login-visual-chip"><i /> {t("connected")}</span></div>
            <div className="login-orbit"><div className="login-orbit-ring login-orbit-ring-one" /><div className="login-orbit-ring login-orbit-ring-two" /><BrandMark /><span className="login-orbit-dot login-orbit-dot-one" /><span className="login-orbit-dot login-orbit-dot-two" /></div>
            <div className="login-visual-copy"><span>{t("workspace")}</span><h2>{t("allHere")}</h2><p>{t("workspaceHint")}</p><div className="login-visual-stats"><div><strong>24/7</strong><span>{t("alwaysOn")}</span></div><div><strong>WSS</strong><span>{t("encrypted")}</span></div><div><strong>LIVE</strong><span>{t("live")}</span></div></div></div>
          </aside>
        </div>
      </div>
    );
  return <Console logout={logout} logoutBusy={busy} sessionError={error} />;
}

function Console({
  logout,
  logoutBusy,
  sessionError,
}: {
  logout: () => void;
  logoutBusy: boolean;
  sessionError: string;
}) {
  const { t } = useTranslation();
  const { page, deviceId, tab } = useRoute();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const pending = useRef(false);
  const refresh = useCallback(async (visible = true) => {
    if (pending.current) return;
    pending.current = true;
    if (visible) setRefreshing(true);
    try {
      setDevices(await api<Device[]>("/devices"));
      setError("");
      setUpdated(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
      pending.current = false;
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(false), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    setMobileNav(false);
    window.scrollTo(0, 0);
  }, [page, deviceId]);
  const device = devices.find((d) => d.id === deviceId);
  const labels = {
    devices: t("management"),
    connections: t("connections"),
    audit: t("audit"),
    "client-config": t("clientConfig"),
  };
  const items = [
    { key: "devices", icon: <LayoutDashboard size={17} />, label: t("management") },
    { key: "client-config", icon: <Settings2 size={17} />, label: t("clientConfig") },
    { key: "connections", icon: <Activity size={17} />, label: t("connections") },
    { key: "audit", icon: <ShieldCheck size={17} />, label: t("audit") },
  ];
  const menu = (compact = false) => (
    <Menu
      mode="inline"
      inlineCollapsed={compact}
      selectedKeys={[page]}
      items={items}
      onClick={({ key }) => {
        navigate(`/${key}`);
        setMobileNav(false);
      }}
    />
  );
  return (
    <PageTransition key={`${page}:${deviceId ?? ""}`} loading={loading}>
      <div className={`admin-layout ${collapsed ? "nav-collapsed" : ""}`}>
        <aside className="desktop-sidebar">
          <a className="brand" href="#/devices" aria-label={t("brandHome")}>
            <BrandMark />
            {!collapsed && (
              <span>
                Rust Remote<small>{t("consoleSubtitle")}</small>
              </span>
            )}
          </a>
          <div className="navigation-label">
            {collapsed ? t("managementShort") : t("managementNav")}
          </div>
          {menu(collapsed)}
          <div className="sidebar-footer">
            <ShieldCheck size={15} />
            {!collapsed && <span>{t("adminWorkspace")}</span>}
          </div>
        </aside>
        <Drawer
          className="navigation-drawer"
          title="Rust Remote"
          placement="left"
          size={248}
          open={mobileNav}
          onClose={() => setMobileNav(false)}
        >
          {menu()}
        </Drawer>
        <div className="workspace">
          <header className="topbar">
            <div className="topbar-left">
              <Tooltip title={collapsed ? t("expandMenu") : t("collapseMenu")}>
                <Button
                  type="text"
                  className="desktop-collapse"
                  aria-label={collapsed ? t("expandMenu") : t("collapseMenu")}
                  icon={
                    collapsed ? (
                      <PanelLeftOpen size={18} />
                    ) : (
                      <PanelLeftClose size={18} />
                    )
                  }
                  onClick={() => setCollapsed(!collapsed)}
                />
              </Tooltip>
              <Button
                type="text"
                className="mobile-menu"
                aria-label={t("openMenu")}
                icon={<MenuIcon size={19} />}
                onClick={() => setMobileNav(true)}
              />
              <Breadcrumb
                items={[
                  { title: t("console") },
                  {
                    title: deviceId ? (
                      <a href="#/devices">{t("management")}</a>
                    ) : (
                      labels[page]
                    ),
                  },
                    ...(deviceId ? [{ title: device?.name || t("deviceDetail") }] : []),
                ]}
              />
            </div>
            <div className="topbar-actions">
              <LanguageSwitch />
              <ThemeSwitch />
              <span className="header-divider" />
              <Dropdown
                trigger={["click"]}
                menu={{
                  items: [
                    {
                      key: "logout",
                      label: t("logout"),
                      icon: <LogOut size={15} />,
                      disabled: logoutBusy,
                      onClick: logout,
                    },
                  ],
                }}
              >
                <Button type="text" className="user-menu" aria-label={t("administrator")}>
                  <Avatar size={26} icon={<ShieldCheck size={14} />} />
                  <span>{t("administrator")}</span>
                  <ChevronDown size={12} />
                </Button>
              </Dropdown>
            </div>
          </header>
          <main className="content">
            {(error || sessionError) && (
              <Alert
                className="page-alert"
                type="error"
                showIcon
                title={t("requestFailed")}
                description={error || sessionError}
                action={
                  <Button size="small" onClick={() => void refresh()}>
                    {t("retry")}
                  </Button>
                }
              />
            )}
            <Suspense fallback={<PageLoadingFallback />}>
              {page === "client-config" ? (
                <ClientConfig />
              ) : page === "audit" ? (
                <AuditView />
              ) : page === "connections" ? (
                <>
                  <PageHeader
                    title={t("connections")}
                    description={t("connectionHint")}
                  />
                  <ConnectionHistory
                    onDevice={(id) =>
                      navigate(`/devices/${encodeURIComponent(id)}/connections`)
                    }
                  />
                </>
              ) : deviceId ? (
                device ? (
                  <DeviceWorkspace key={device.id} device={device} tab={tab} />
                ) : loading ? (
                  <Loading />
                ) : (
                  <Result
                    status="404"
                    title={t("deviceMissing")}
                    subTitle={t("deviceMissingHint")}
                    extra={
                      <Button type="primary" onClick={() => navigate("/devices")}>
                        {t("backToDevices")}
                      </Button>
                    }
                  />
                )
              ) : (
                <DeviceList
                  devices={devices}
                  loading={loading}
                  refreshing={refreshing}
                  refresh={() => void refresh()}
                  updated={updated}
                  syncFailed={!!error}
                />
              )}
            </Suspense>
            <footer className="app-footer">
              <span>Rust Remote</span>
              <span>{t("consoleSubtitle")}</span>
            </footer>
          </main>
        </div>
      </div>
    </PageTransition>
  );
}
