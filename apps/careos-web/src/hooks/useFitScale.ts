import { useEffect, useState } from "react";
import { fitScale } from "../lib/fit";

/** Scale for the fixed 1920x1080 device canvas so it always fits the browser window. */
export function useFitScale(): number {
  const [scale, setScale] = useState(() => fitScale(window.innerWidth, window.innerHeight));
  useEffect(() => {
    const on = () => setScale(fitScale(window.innerWidth, window.innerHeight));
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return scale;
}
