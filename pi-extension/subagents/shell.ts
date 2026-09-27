/**
 * Shell-escaping helper shared by every terminal backend (tmux, Herdr, …).
 * Pulled out of tmux.ts so it has no multiplexer-specific baggage.
 */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
