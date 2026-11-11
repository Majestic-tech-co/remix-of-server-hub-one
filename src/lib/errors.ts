// Turn any backend error into a safe, generic message for the UI.
// Full detail goes to the console only in development; never shown to users.

const KNOWN: Array<[RegExp, string]> = [
  [/invalid login credentials/i, "Incorrect email or password."],
  [/email not confirmed/i, "Please confirm your email first. Check your inbox for the link."],
  [/rate limit|too many|over_.*_rate_limit|429/i, "Too many attempts. Please wait a few minutes and try again."],
  [/captcha/i, "Verification failed. Please complete the check and try again."],
  [/network|failed to fetch|load failed/i, "Network problem. Check your connection and try again."],
  [/jwt|token.*(expired|invalid)|session/i, "Your session has expired. Please sign in again."],
  [/password.*(weak|short|least|characters)|weak_password/i, "That password is too weak. Use at least 10 characters."],
];

export function friendlyError(err: unknown, fallback = "Something went wrong. Please try again."): string {
  const raw =
    err instanceof Error ? err.message : typeof err === "object" && err && "message" in err ? String((err as { message: unknown }).message) : "";
  if (import.meta.env.DEV && raw) console.error("[error]", raw);
  for (const [re, msg] of KNOWN) if (re.test(raw)) return msg;
  return fallback;
}
