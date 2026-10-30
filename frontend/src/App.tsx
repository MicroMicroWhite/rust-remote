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
  const [session, setSession] = useState<"loading" | "guest" | "ready">(
    "loading",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
      setError("会话已过期，请重新登录。");
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
          title="入口不存在"
          subTitle="请使用安装时生成的控制台入口地址。"
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
          <ThemeSwitch />
        </div>
        <div className="login-shell">
          <main className="login-box">
          <div className="login-brand">
            <BrandMark />
            <span>
              Rust Remote<small>设备管理控制台</small>
            </span>
          </div>
          <section className="login-card">
            <div className="login-kicker"><LockKeyhole size={15} /> 管理员登录</div>
            <h1>欢迎回来。</h1>
            <p className="muted">输入管理密码，进入你的设备工作台。</p>
            <Form
              layout="vertical"
              onFinish={login}
              requiredMark={false}
              size="large"
            >
              <Form.Item
                name="password"
                label="管理密码"
                rules={[{ required: true, message: "请输入管理密码" }]}
              >
                <Input.Password
                  prefix={<LockKeyhole size={16} />}
                  placeholder="请输入管理密码"
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
                进入控制台 <ArrowRight size={16} />
              </Button>
            </Form>
            <div className="login-foot">
              <ShieldCheck size={14} />
              仅限授权管理员访问
            </div>
          </section>
          <div className="login-copyright">Rust Remote · 远程设备管理</div>
          </main>
          <aside className="login-visual" aria-label="远程设备管理介绍">
            <div className="login-visual-top"><span>远程设备管理</span><span className="login-visual-chip"><i /> 连接正常</span></div>
            <div className="login-orbit"><div className="login-orbit-ring login-orbit-ring-one" /><div className="login-orbit-ring login-orbit-ring-two" /><BrandMark /><span className="login-orbit-dot login-orbit-dot-one" /><span className="login-orbit-dot login-orbit-dot-two" /></div>
            <div className="login-visual-copy"><span>设备工作台</span><h2>设备，都在这里。</h2><p>查看设备状态，执行远程操作，发布客户端更新。</p><div className="login-visual-stats"><div><strong>24/7</strong><span>持续连接</span></div><div><strong>WSS</strong><span>加密连接</span></div><div><strong>LIVE</strong><span>实时状态</span></div></div></div>
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
    devices: "设备管理",
    connections: "上下线记录",
    audit: "操作审计",
    "client-config": "被控端配置",
  };
  const items = [
    { key: "devices", icon: <LayoutDashboard size={17} />, label: "设备管理" },
    { key: "client-config", icon: <Settings2 size={17} />, label: "被控端配置" },
    { key: "connections", icon: <Activity size={17} />, label: "上下线记录" },
    { key: "audit", icon: <ShieldCheck size={17} />, label: "操作审计" },
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
          <a className="brand" href="#/devices" aria-label="Rust Remote 首页">
            <BrandMark />
            {!collapsed && (
              <span>
                Rust Remote<small>管理控制台</small>
              </span>
            )}
          </a>
          <div className="navigation-label">
            {collapsed ? "管理" : "设备与运维"}
          </div>
          {menu(collapsed)}
          <div className="sidebar-footer">
            <ShieldCheck size={15} />
            {!collapsed && <span>管理员工作空间</span>}
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
              <Tooltip title={collapsed ? "展开菜单" : "收起菜单"}>
                <Button
                  type="text"
                  className="desktop-collapse"
                  aria-label={collapsed ? "展开菜单" : "收起菜单"}
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
                aria-label="打开菜单"
                icon={<MenuIcon size={19} />}
                onClick={() => setMobileNav(true)}
              />
              <Breadcrumb
                items={[
                  { title: "控制台" },
                  {
                    title: deviceId ? (
                      <a href="#/devices">设备管理</a>
                    ) : (
                      labels[page]
                    ),
                  },
                  ...(deviceId ? [{ title: device?.name || "设备详情" }] : []),
                ]}
              />
            </div>
            <div className="topbar-actions">
              <ThemeSwitch />
              <span className="header-divider" />
              <Dropdown
                trigger={["click"]}
                menu={{
                  items: [
                    {
                      key: "logout",
                      label: "退出登录",
                      icon: <LogOut size={15} />,
                      disabled: logoutBusy,
                      onClick: logout,
                    },
                  ],
                }}
              >
                <Button type="text" className="user-menu" aria-label="管理员菜单">
                  <Avatar size={26} icon={<ShieldCheck size={14} />} />
                  <span>管理员</span>
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
                title="请求失败"
                description={error || sessionError}
                action={
                  <Button size="small" onClick={() => void refresh()}>
                    重试
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
                    title="上下线记录"
                    description="查看设备连接时间、连接时长及断开原因。"
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
                    title="设备不存在"
                    subTitle="该设备可能尚未连接，或地址已失效。"
                    extra={
                      <Button type="primary" onClick={() => navigate("/devices")}>
                        返回设备列表
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
              <span>设备管理控制台</span>
            </footer>
          </main>
        </div>
      </div>
    </PageTransition>
  );
}
