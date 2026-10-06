/** The business name shown throughout the shell — sidebar, login, splash,
 * page title, logout prompt, backup messages. Defined ONCE here: the rename
 * away from an earlier name was once done in the sidebar only, leaving the login
 * page, the browser tab, the backup errors and the home-screen icon label
 * all still saying the old name. Keep public/manifest.webmanifest in step by
 * hand — a static JSON file can't import this. */
export const APP_NAME = "M Décor";
/** The line under the name, from the logo itself. */
export const APP_TAGLINE = "Sofa · Curtain · Mattress";

/** Bump on every deploy — shown on the login page and Settings so we can
 * always tell which version a user is actually running. */
export const APP_VERSION = "16 Sep 2026 · v116";
