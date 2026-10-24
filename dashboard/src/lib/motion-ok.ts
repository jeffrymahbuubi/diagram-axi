/** True when the reader allows motion. Islands and scripts check this before animating. */
export function motionOK(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
}
