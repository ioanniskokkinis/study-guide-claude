/**
 * Blocking, pre-hydration theme script (Phase 18.1) — must run before first
 * paint so an explicit light/dark choice never flashes the wrong theme.
 * Reads localStorage only; a missing/invalid value leaves data-theme unset,
 * which falls back to the deliberate prefers-color-scheme palette in
 * globals.css. Deliberately not a React effect — an effect runs after
 * paint, which is exactly the flash this exists to avoid.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
