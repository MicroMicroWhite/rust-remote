import { useEffect, useRef, useState } from "react";
import { Button, Tag } from "antd";
import { Terminal as TerminalIcon } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { terminalSocket } from "./api";
import { useTranslation } from "react-i18next";

export default function TerminalView({ id, disabled }: { id: string; disabled: boolean }) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"idle" | "connecting" | "ready" | "closed">("idle");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      cursorBlink: true, fontSize: 14, scrollback: 5000,
      fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: { background: "#141820", foreground: "#e6edf3", cursor: "#91caff", selectionBackground: "#264f78" },
      disableStdin: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    terminal.current = term;
    let disposed = false;
    let ready = false;
    let ended = false;
    let ws: WebSocket | null = null;
    let resizeFrame = 0;
    const send = (value: unknown) => {
      if (ws?.readyState !== WebSocket.OPEN || disposed) return;
      if (ws.bufferedAmount > 256 * 1024) {
        setDetail(t("terminalBufferFull"));
        ws.close();
        return;
      }
      ws.send(JSON.stringify(value));
    };
    const resize = () => {
      if (disposed || !host.current?.clientWidth || !host.current.clientHeight) return;
      fit.fit();
      const cols = Math.min(500, Math.max(2, term.cols));
      const rows = Math.min(300, Math.max(1, term.rows));
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      if (ready) send({ type: "resize", cols, rows });
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    });
    observer.observe(host.current);
    resize();
    const input = term.onData((data) => {
      if (!ready) return;
      // Code points stay intact across frames, including pasted CJK and emoji.
      let chunk = "";
      for (const character of data) {
        chunk += character;
        if (chunk.length >= 1000) { send({ type: "input", data: chunk }); chunk = ""; }
      }
      if (chunk) send({ type: "input", data: chunk });
    });
    setDetail("");
    if (disabled || attempt === 0) {
      setStatus("idle");
    } else {
      setStatus("connecting");
      ws = terminalSocket(id, Math.min(500, Math.max(2, term.cols)), Math.min(300, Math.max(1, term.rows)));
      socket.current = ws;
      ws.onmessage = (event) => {
        if (disposed) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "ready") {
            ready = true;
            term.options.disableStdin = false;
            setStatus("ready");
            resize();
            term.focus();
          } else if (message.type === "output") {
            const data = Uint8Array.from(atob(message.data), (c) => c.charCodeAt(0));
            // xterm decodes UTF-8 incrementally, including split multibyte output.
            term.write(data, () => { if (ready) send({ type: "ack", sequence: message.sequence }); });
          } else if (message.type === "exit") {
            ended = true;
            setDetail(t("terminalExited", { code: message.exit_code == null ? "" : `, exit code ${message.exit_code}` }));
          } else if (message.type === "error") {
            ended = true;
            setDetail(message.detail || t("terminalConnectionFailed"));
          }
        } catch {
          setDetail(t("invalidTerminalData"));
          ws?.close();
        }
      };
      ws.onerror = () => { if (!disposed) setDetail(t("terminalConnectionFailed")); };
      ws.onclose = () => {
        ready = false;
        term.options.disableStdin = true;
        if (!disposed) {
          setStatus("closed");
          if (!ended) setDetail((previous) => previous || t("terminalClosed"));
        }
      };
    }
    return () => {
      disposed = true;
      ready = false;
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      input.dispose();
      ws?.close();
      if (socket.current === ws) socket.current = null;
      term.dispose();
      if (terminal.current === term) terminal.current = null;
    };
  }, [id, disabled, attempt]);

  return <section className="table-panel terminal-panel">
    <div className="table-toolbar">
      <div className="toolbar-title"><TerminalIcon size={17} />{t("interactiveTerminal")}
        <Tag color={status === "ready" ? "success" : "default"}>
          {{ idle: t("notConnected"), connecting: t("connecting"), ready: t("connected"), closed: t("disconnected") }[status]}
        </Tag>
      </div>
      <div className="toolbar-actions">
        <Button onClick={() => terminal.current?.clear()}>{t("clearDisplay")}</Button>
        {status === "ready" || status === "connecting" ?
          <Button onClick={() => socket.current?.close()}>{t("disconnect")}</Button> :
          <Button type="primary" disabled={disabled} onClick={() => setAttempt((n) => n + 1)}>
            {attempt ? t("reconnect") : t("connectTerminal")}
          </Button>}
      </div>
    </div>
    <div ref={host} className="interactive-terminal" aria-label={t("interactiveTerminal")} />
    <div className="panel-note" role="status">
      {disabled ? t("terminalDisabled") : detail || t("terminalSessionNote")}
      <br />{t("terminalSessionWarning")}
    </div>
  </section>;
}
