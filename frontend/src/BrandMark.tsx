import brandMark from "./assets/brand-mark-animated.svg";

export function BrandMark() {
  return <img className="brand-mark" src={brandMark} alt="" aria-hidden="true" draggable={false} />;
}
