export function safeMarkdownHref(href: string): string | null {
  if (href.startsWith('#')) return href;
  try {
    const url = new URL(href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : null;
  } catch {
    return null;
  }
}
