// Settings opens as a panel over the app. The panel is still a route (links and reloads land in it), so it
// remembers the screen it opened over and returns there on close.

let returnTo: string | null = null;

/** Called by the workspace shell for every location outside Settings. */
export function rememberBeneathSettings(href: string): void {
  returnTo = href;
}

/** Where closing Settings goes: the screen it opened over, else the workspace home. */
export function settingsReturnTarget(fallback: string): string {
  return returnTo ?? fallback;
}
