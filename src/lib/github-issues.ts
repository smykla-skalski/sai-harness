export function issueBranch(issue: { number: number; title: string }): string {
  const prefix = `issue-${issue.number}`;
  const slug = issue.title
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const available = 64 - prefix.length - 1;
  return slug && available > 0
    ? `${prefix}-${slug.slice(0, available).replace(/-$/g, '')}`
    : prefix;
}
