import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { BrandMark } from "./BrandMark";

const LoadingContext = createContext<(() => () => void) | null>(null);
const minimumDuration = 280;
const exitDuration = 180;

// Only the initial route reveal waits for these loads. Later refreshes stay local.
export function usePageLoading(loading: boolean) {
  const register = useContext(LoadingContext);
  useLayoutEffect(() => {
    if (loading && register) return register();
  }, [loading, register]);
}

export function PageLoadingFallback() {
  usePageLoading(true);
  return null;
}

export function PageTransition({
  children,
  loading,
}: {
  children: ReactNode;
  loading: boolean;
}) {
  const [pending, setPending] = useState(0);
  const [phase, setPhase] = useState<"loading" | "leaving" | "hidden">(
    "loading",
  );
  const startedAt = useRef(performance.now());
  const register = useCallback(() => {
    setPending((count) => count + 1);
    return () => setPending((count) => count - 1);
  }, []);
  const visible = phase !== "hidden";

  useEffect(() => {
    if (phase === "hidden") return;
    if (loading || pending > 0) {
      setPhase("loading");
      return;
    }
    if (phase === "leaving") return;
    const timer = window.setTimeout(
      () => setPhase("leaving"),
      Math.max(0, minimumDuration - (performance.now() - startedAt.current)),
    );
    return () => window.clearTimeout(timer);
  }, [loading, pending, phase]);

  useEffect(() => {
    if (phase !== "leaving") return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const timer = window.setTimeout(
      () => setPhase("hidden"),
      reducedMotion ? 0 : exitDuration,
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  useLayoutEffect(() => {
    if (!visible) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [visible]);

  return (
    <LoadingContext.Provider value={register}>
      <div inert={visible} aria-busy={visible}>
        {children}
      </div>
      {visible &&
        createPortal(
          <div
            className={`page-transition${phase === "leaving" ? " page-transition-leaving" : ""}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="page-transition-indicator">
              <BrandMark />
              <span>正在加载…</span>
              <span className="page-transition-progress" aria-hidden="true" />
            </div>
          </div>,
          document.body,
        )}
    </LoadingContext.Provider>
  );
}
