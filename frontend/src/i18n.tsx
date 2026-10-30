import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { Segmented } from "antd";

const resources = {
  zh: {
    translation: {
      language: "语言",
      appearance: "外观模式",
      light: "浅色",
      dark: "深色",
      system: "自动",
      chinese: "中文",
      english: "English",
      console: "控制台",
      login: "管理员登录",
      welcome: "欢迎回来。",
      loginHint: "输入管理密码，进入你的设备工作台。",
      password: "管理密码",
      passwordRequired: "请输入管理密码",
      passwordPlaceholder: "请输入管理密码",
      enterConsole: "进入控制台",
      authorizedOnly: "仅限授权管理员访问",
      remoteManagement: "远程设备管理",
      connected: "连接正常",
      workspace: "设备工作台",
      allHere: "设备，都在这里。",
      workspaceHint: "查看设备状态，执行远程操作，发布客户端更新。",
      alwaysOn: "持续连接",
      encrypted: "加密连接",
      live: "实时状态",
      invalidEntry: "入口不存在",
      invalidEntryHint: "请使用安装时生成的控制台入口地址。",
      expired: "会话已过期，请重新登录。",
      management: "设备管理",
      connections: "上下线记录",
      audit: "操作审计",
      clientConfig: "被控端配置",
      managementNav: "设备与运维",
      managementShort: "管理",
      adminWorkspace: "管理员工作空间",
      expandMenu: "展开菜单",
      collapseMenu: "收起菜单",
      openMenu: "打开菜单",
      deviceDetail: "设备详情",
      administrator: "管理员",
      logout: "退出登录",
      requestFailed: "请求失败",
      retry: "重试",
      deviceMissing: "设备不存在",
      deviceMissingHint: "该设备可能尚未连接，或地址已失效。",
      backToDevices: "返回设备列表",
      connectionHint: "查看设备连接时间、连接时长及断开原因。",
      consoleSubtitle: "设备管理控制台",
      brandHome: "Rust Remote 首页",
      loading: "正在加载…",
      online: "在线",
      offline: "离线",
      total: "共 {{count}} 条",
    },
  },
  en: {
    translation: {
      language: "Language",
      appearance: "Appearance",
      light: "Light",
      dark: "Dark",
      system: "System",
      chinese: "中文",
      english: "English",
      console: "Console",
      login: "Administrator sign in",
      welcome: "Welcome back.",
      loginHint: "Enter the management password to open your device workspace.",
      password: "Management password",
      passwordRequired: "Please enter the management password",
      passwordPlaceholder: "Enter management password",
      enterConsole: "Open console",
      authorizedOnly: "Authorized administrators only",
      remoteManagement: "Remote device management",
      connected: "Connected",
      workspace: "Device workspace",
      allHere: "Every device, in one place.",
      workspaceHint: "View device status, run remote operations, and publish client updates.",
      alwaysOn: "Always connected",
      encrypted: "Encrypted",
      live: "Live status",
      invalidEntry: "Entry not found",
      invalidEntryHint: "Use the console URL generated during installation.",
      expired: "Your session expired. Please sign in again.",
      management: "Devices",
      connections: "Connection history",
      audit: "Audit log",
      clientConfig: "Client configuration",
      managementNav: "Devices & operations",
      managementShort: "Manage",
      adminWorkspace: "Administrator workspace",
      expandMenu: "Expand menu",
      collapseMenu: "Collapse menu",
      openMenu: "Open menu",
      deviceDetail: "Device details",
      administrator: "Administrator",
      logout: "Sign out",
      requestFailed: "Request failed",
      retry: "Retry",
      deviceMissing: "Device not found",
      deviceMissingHint: "The device may be disconnected or the URL is no longer valid.",
      backToDevices: "Back to devices",
      connectionHint: "View connection times, durations, and disconnect reasons.",
      consoleSubtitle: "Device management console",
      brandHome: "Rust Remote home",
      loading: "Loading…",
      online: "Online",
      offline: "Offline",
      total: "{{count}} total",
    },
  },
} as const;

let saved: string | null = null;
try { saved = localStorage.getItem("remote-language"); } catch {}
const browserLanguage = typeof navigator === "undefined" ? "zh" : navigator.language;
const initial = saved === "en" || saved === "zh" ? saved : browserLanguage.toLowerCase().startsWith("zh") ? "zh" : "en";

void i18n.use(initReactI18next).init({
  resources,
  lng: initial,
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
});

export default i18n;

export function LanguageSwitch() {
  const { i18n: instance, t } = useTranslation();
  return (
    <Segmented
      size="small"
      aria-label={t("language")}
      value={instance.language.startsWith("en") ? "en" : "zh"}
      onChange={(value) => {
        const language = value as "zh" | "en";
        void instance.changeLanguage(language);
        try { localStorage.setItem("remote-language", language); } catch {}
      }}
      options={[{ value: "zh", label: t("chinese") }, { value: "en", label: t("english") }]}
    />
  );
}
