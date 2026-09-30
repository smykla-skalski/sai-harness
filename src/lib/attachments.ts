export function fileUri(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file://${absolute
    .split('/')
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')}`;
}
