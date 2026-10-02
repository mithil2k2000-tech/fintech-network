// Turning whatever a camera or a person gives us into a request key.
// A QR carries a link like https://host/pay/r/<token>, but people may
// also type a REQ- code, so both are accepted here.

const CODE_RE = /REQ-[A-HJ-NP-Z2-9]{8}/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function extractRequestKey(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  // A link from a QR code: take the last path segment.
  try {
    const url = new URL(text);
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    if (TOKEN_RE.test(last)) return last;
    const inPath = CODE_RE.exec(url.pathname);
    if (inPath) return inPath[0].toUpperCase();
    return null;
  } catch {
    // Not a URL — fall through.
  }

  if (TOKEN_RE.test(text)) return text;
  const code = CODE_RE.exec(text.replace(/\s+/g, ""));
  return code ? code[0].toUpperCase() : null;
}

/** The link a QR code carries, so scanning it in any camera app works. */
export function requestLink(token: string, origin = window.location.origin): string {
  return `${origin}/pay/r/${token}`;
}
