/** The Echo Show 15 simulator is designed at 1920x1080 and scaled down to fit the browser window (never up past 1). */
export const DESIGN = { width: 1920, height: 1080 } as const;

export function fitScale(viewportWidth: number, viewportHeight: number): number {
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) return 1;
  return Math.min(1, viewportWidth / DESIGN.width, viewportHeight / DESIGN.height);
}
