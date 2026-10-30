import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Alert, Button, Dropdown, Input, Modal, Select, Space, Switch, Tag } from "antd";
import { Keyboard, Monitor, MousePointer2, Play, RefreshCw, Square } from "lucide-react";
import { command, screenSocket } from "./api";
import { useTranslation } from "react-i18next";

type Props = { id: string; setError: (error: string) => void; inputSupported: boolean };
type DesktopInput = { kind: string; [key: string]: unknown };
const namedKeys = new Set(["Enter", "Escape", "Backspace", "Tab", "Delete", "Insert", "Home", "End",
  "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "CapsLock",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);
const shortcuts = [
  { label: "Enter", key: "Enter", modifiers: [] },
  { label: "Esc", key: "Escape", modifiers: [] },
  { label: "Tab", key: "Tab", modifiers: [] },
  { label: "Backspace", key: "Backspace", modifiers: [] },
  { label: "Ctrl + A", key: "a", modifiers: ["Control"] },
  { label: "Ctrl + C", key: "c", modifiers: ["Control"] },
  { label: "Ctrl + V", key: "v", modifiers: ["Control"] },
  { label: "Alt + Tab", key: "Tab", modifiers: ["Alt"] },
  { label: "Win + D", key: "d", modifiers: ["Meta"] },
];

function modifiers(event: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }) {
  return [event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta"].filter(Boolean);
}

export default function ScreenView({ id, setError, inputSupported }: Props) {
  const { t } = useTranslation();
  const [src, setSrc] = useState("");
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [fps, setFps] = useState(15);
  const [actualFps, setActualFps] = useState(0);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const [control, setControl] = useState(false);
  const [focused, setFocused] = useState(false);
  const [updated, setUpdated] = useState("");
  const [textOpen, setTextOpen] = useState(false);
  const [text, setText] = useState("");
  const [textSending, setTextSending] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const frameCount = useRef({ started: 0, count: 0 });
  const controlEnabled = useRef(false);
  const inputEpoch = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const queued = useRef(0);
  const capturePending = useRef(false);
  const mounted = useRef(true);
  const enabled = control && connected && !!src && inputSupported;

  const stopControl = useCallback(() => {
    controlEnabled.current = false;
    inputEpoch.current++;
    setControl(false);
    setTextOpen(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controlEnabled.current = false; inputEpoch.current++; };
  }, []);

  useEffect(() => {
    const hide = () => { if (document.hidden) { stopControl(); setRunning(false); setConnected(false); } };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [stopControl]);

  const showFrame = useCallback((data: string) => {
    setSrc(`data:image/jpeg;base64,${data}`);
    setUpdated(new Date().toLocaleTimeString(undefined, { hour12: false }));
  }, []);

  useEffect(() => {
    if (!running) return;
    let active = true;
    let reported = false;
    frameCount.current = { started: performance.now(), count: 0 };
    const ws = screenSocket(id, fpsRef.current);
    socket.current = ws;
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "configure", fps: fpsRef.current })));
    const failed = (message: string) => {
      if (!active) return;
      if (!reported) setError(message);
      reported = true;
      stopControl();
      setConnected(false);
      setRunning(false);
    };
    ws.onmessage = (event) => {
      if (!active) return;
      try {
        const value = JSON.parse(event.data);
        if (value.type === "error") { failed(value.detail || t("screenConnectionInterrupted")); return; }
        if (value.type !== "frame" || typeof value.data !== "string") return;
        setConnected(true);
        showFrame(value.data);
        const counter = frameCount.current;
        counter.count++;
        const elapsed = performance.now() - counter.started;
        if (elapsed >= 1000) {
          setActualFps(Math.round(counter.count * 10000 / elapsed) / 10);
          frameCount.current = { started: performance.now(), count: 0 };
        }
      } catch { failed(t("invalidScreenData")); }
    };
    ws.onerror = () => failed(t("screenConnectionFailed"));
    ws.onclose = () => failed(t("screenConnectionClosed"));
    return () => {
      active = false;
      socket.current = null;
      ws.close();
      controlEnabled.current = false;
      inputEpoch.current++;
    };
    // FPS changes use configure messages and keep the same stream/session.
  }, [running, id, setError, showFrame, stopControl]);

  async function capture() {
    if (capturePending.current || running) return;
    capturePending.current = true;
    setCapturing(true);
    try {
      const result = await command<{ data: string }>(id, "screen.capture");
      if (mounted.current) showFrame(result.data);
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { capturePending.current = false; if (mounted.current) setCapturing(false); }
  }

  function enqueue(input: DesktopInput): Promise<boolean> {
    if (!controlEnabled.current || queued.current >= 32) return Promise.resolve(false);
    const epoch = inputEpoch.current;
    queued.current++;
    const job = queue.current.then(async () => {
      if (epoch !== inputEpoch.current || !controlEnabled.current) return false;
      await command(id, "screen.input", input);
      return true;
    }).catch((e) => {
      if (mounted.current && epoch === inputEpoch.current) {
        stopControl();
        setError((e as Error).message);
      }
      return false;
    }).finally(() => { queued.current--; });
    queue.current = job.then(() => {});
    return job;
  }

  function position(clientX: number, clientY: number) {
    const img = image.current;
    if (!img?.naturalWidth || !img.naturalHeight) return null;
    const rect = img.getBoundingClientRect();
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    const width = img.naturalWidth * scale, height = img.naturalHeight * scale;
    const x = (clientX - rect.left - (rect.width - width) / 2) / width;
    const y = (clientY - rect.top - (rect.height - height) / 2) / height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }

  function pointer(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || event.button > 2) return;
    const point = position(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    viewport.current?.focus({ preventScroll: true });
    void enqueue({ kind: "click", ...point, button: ["left", "middle", "right"][event.button], modifiers: modifiers(event) });
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!enabled || event.nativeEvent.isComposing || event.key === "Process" || event.key === "Dead") return;
    if (event.key === "Escape" && event.shiftKey) {
      event.preventDefault(); stopControl(); viewport.current?.blur(); return;
    }
    if (!namedKeys.has(event.key) && Array.from(event.key).length !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    void enqueue({ kind: "key", key: event.key, modifiers: modifiers(event) });
  }

  // A native non-passive listener prevents the local page from scrolling while
  // directing the wheel to the remote screen.
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  wheelHandler.current = (event) => {
    if (!enabled || !event.deltaY) return;
    const point = position(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    void enqueue({ kind: "scroll", ...point, modifiers: modifiers(event), amount: Math.sign(event.deltaY) * Math.min(20,
      Math.max(1, Math.round(Math.abs(event.deltaY) / (event.deltaMode === 0 ? 100 : 1)))) });
  };
  useEffect(() => {
    const node = viewport.current;
    const handler = (event: WheelEvent) => wheelHandler.current(event);
    node?.addEventListener("wheel", handler, { passive: false });
    return () => node?.removeEventListener("wheel", handler);
  }, []);

  return <section className="table-panel screen-panel">
    <div className="table-toolbar screen-toolbar">
      <div className="toolbar-title">{t("mainScreen")}
        <Tag color={connected ? "processing" : "default"}>{running ? connected ? t("watching") : t("connectingScreen") : t("paused")}</Tag>
        {connected && <span className="secondary-text">{t("actualFps", { fps: actualFps })}</span>}
      </div>
      <Space wrap>
        <label className="screen-fps-label">{t("targetFps")}
          <Select aria-label={t("screenFps")} value={fps} className="screen-fps" options={[1, 5, 10, 15, 20, 30].map((value) => ({ value, label: `${value} FPS` }))}
            onChange={(value) => { setFps(value); if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "configure", fps: value })); }} />
        </label>
        <Button icon={<RefreshCw size={14} />} loading={capturing} disabled={running} onClick={() => void capture()}>{t("capture")}</Button>
        <Button type={running ? "default" : "primary"} icon={running ? <Square size={14} /> : <Play size={14} />}
          disabled={capturing} onClick={() => {
            stopControl(); setConnected(false); setActualFps(0); setError(""); setRunning(!running);
          }}>{running ? t("pauseWatching") : t("startWatching")}</Button>
      </Space>
    </div>
    <div className="screen-control-toolbar">
      <label className="switch-field"><Switch size="small" checked={control} disabled={!connected || !inputSupported}
        aria-label={t("mouseKeyboard")} onChange={(value) => {
          if (!value) { stopControl(); return; }
          controlEnabled.current = true; setControl(true); viewport.current?.focus({ preventScroll: true });
        }} /><MousePointer2 size={14} />{t("mouseKeyboard")}</label>
      <span className="secondary-text">{enabled ? focused ? t("keyboardConnected") : t("clickScreenInput") : t("enableWatchingControl")}</span>
      <Space wrap>
        <Dropdown disabled={!enabled} trigger={["click"]} menu={{ items: shortcuts.map((item, i) => ({ key: String(i), label: item.label })),
          onClick: ({ key }) => { const item = shortcuts[Number(key)]; void enqueue({ kind: "key", key: item.key, modifiers: item.modifiers }); viewport.current?.focus({ preventScroll: true }); } }}>
          <Button size="small" icon={<Keyboard size={14} />} disabled={!enabled}>{t("sendKey")}</Button>
        </Dropdown>
        <Button size="small" disabled={!enabled} onClick={() => setTextOpen(true)}>{t("inputText")}</Button>
      </Space>
    </div>
    {!inputSupported && <Alert className="inline-alert" type="info" showIcon title={t("upgradeForInput")} />}
    <div ref={viewport} className={`screen-preview ${src ? "has-image" : ""} ${enabled ? "screen-controlling" : ""}`}
      tabIndex={enabled ? 0 : -1} role="application" aria-label={t("remoteScreen")}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onPointerDown={pointer} onKeyDown={keyboard}
      onContextMenu={(event) => { if (enabled) event.preventDefault(); }}>
      {src ? <img ref={image} src={src} alt={t("currentScreen")} draggable={false} />
        : <div className="screen-placeholder"><Monitor size={42} strokeWidth={1} /><strong>{t("noScreen")}</strong><p>{t("screenHint")}</p></div>}
    </div>
    <div className="panel-note">{updated ? t("recentFrame", { time: updated }) : ""}{t("screenNote")}
      {enabled && ` ${t("screenControlNote")}`}
      {!running && src && ` ${t("pausedFrame")}`}</div>
    <Modal title={t("inputToDevice")} open={textOpen} okText={t("sendText")} cancelText={t("cancel")} confirmLoading={textSending}
      okButtonProps={{ disabled: !text || !enabled || new TextEncoder().encode(text).length > 4096 }}
      onCancel={() => { if (!textSending) setTextOpen(false); }}
      onOk={async () => { if (textSending || !text || !enabled) return; setTextSending(true);
        const sent = await enqueue({ kind: "text", text }); setTextSending(false);
        if (sent) { setText(""); setTextOpen(false); viewport.current?.focus({ preventScroll: true }); } }}>
      <p className="screen-text-note">{t("textInputNote")}</p>
      <Input.TextArea aria-label={t("sendToDevice")} autoFocus rows={5} value={text} onChange={(e) => setText(e.target.value)} disabled={textSending} maxLength={4096} />
    </Modal>
  </section>;
}
