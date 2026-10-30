import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { ConfigProvider, Segmented, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { Monitor, Moon, Sun } from "lucide-react";

type Mode = "light" | "dark" | "system";
const ThemeContext = createContext<{
  mode: Mode;
  setMode: (mode: Mode) => void;
}>({ mode: "system", setMode: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>(() => {
    try {
      const saved = localStorage.getItem("remote-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {}
    return "system";
  });
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const dark = mode === "dark" || (mode === "system" && systemDark);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("remote-theme", mode);
    } catch {}
  }, [dark, mode]);
  return (
    <ThemeContext.Provider value={{ mode, setMode }}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
          token: {
            colorPrimary: dark ? "#1668dc" : "#1677ff",
            colorBgBase: dark ? "#141414" : "#ffffff",
            colorBgLayout: dark ? "#141414" : "#f5f5f5",
            colorBgContainer: dark ? "#1f1f1f" : "#ffffff",
            colorBgElevated: dark ? "#262626" : "#ffffff",
            colorBorder: dark ? "#424242" : "#d9d9d9",
            borderRadius: 6,
            fontSize: 14,
            controlHeight: 32,
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
          },
          components: {
            Menu: { itemBorderRadius: 5, itemHeight: 40, itemMarginInline: 8 },
            Table: {
              cellPaddingBlock: 12,
              cellPaddingBlockMD: 12,
              headerBg: dark ? "#262626" : "#fafafa",
            },
            Card: { headerHeight: 48, headerFontSize: 14, bodyPadding: 20 },
            Descriptions: { itemPaddingBottom: 16 },
            Segmented: { trackPadding: 3 },
          },
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

export function ThemeSwitch() {
  const { mode, setMode } = useContext(ThemeContext);
  return (
    <Segmented<Mode>
      className="theme-switch"
      aria-label="外观模式"
      value={mode}
      onChange={setMode}
      options={[
        {
          value: "light",
          label: (
            <span>
              <Sun size={14} />
              浅色
            </span>
          ),
        },
        {
          value: "dark",
          label: (
            <span>
              <Moon size={14} />
              深色
            </span>
          ),
        },
        {
          value: "system",
          label: (
            <span>
              <Monitor size={14} />
              自动
            </span>
          ),
        },
      ]}
    />
  );
}
