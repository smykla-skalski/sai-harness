import type { HistoryEntry, PlanStep } from './plan';

export type HistoryRow = {
  id: number;
  at: number;
  version: number;
  title: string;
  details: string[];
};

function stepChange(previous: PlanStep | undefined, current: PlanStep): string[] {
  const lines: string[] = [];
  if (previous && previous.title !== current.title)
    lines.push(`Renamed: ${previous.title} → ${current.title}`);
  if (previous && previous.detail !== current.detail)
    lines.push(`${current.title} detail revised: ${current.detail}`);
  if (previous && previous.files.join('\n') !== current.files.join('\n'))
    lines.push(`${current.title} files revised: ${current.files.join(' · ') || 'None'}`);
  if (previous && previous.risk !== current.risk)
    lines.push(`${current.title} risk revised: ${current.risk}`);
  if (!previous || previous.status !== current.status)
    lines.push(`${current.title}: ${current.status.replaceAll('_', ' ')}`);
  if (current.note && current.note !== previous?.note) lines.push(`Note: ${current.note}`);
  if (current.check && current.check.summary !== previous?.check?.summary)
    lines.push(`Check ${current.check.outcome}: ${current.check.summary}`);
  const touched = current.touched.filter((file) => !previous?.touched.includes(file));
  if (touched.length) lines.push(`Touched: ${touched.join(' · ')}`);
  return lines;
}

export function historyRows(events: HistoryEntry[]): HistoryRow[] {
  const seen = new Set<number>();
  const ordered = events
    .toSorted((a, b) => a.id - b.id)
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
  return ordered.map((event, index) => {
    const previous = ordered[index - 1]?.plan;
    const changed = event.plan.steps.flatMap((step) =>
      stepChange(
        previous?.steps.find((old) => old.id === step.id),
        step,
      ),
    );
    if (previous && previous.summary !== event.plan.summary)
      changed.unshift(`Summary revised: ${event.plan.summary}`);
    if (previous && previous.title !== event.plan.title)
      changed.unshift(`Plan renamed: ${previous.title} → ${event.plan.title}`);
    const outside = event.plan.outside.filter((file) => !previous?.outside.includes(file));
    if (outside.length) changed.push(`Outside active steps: ${outside.join(' · ')}`);
    if (event.reason === 'reviewed') {
      const decisions =
        event.review?.decisions.flatMap((decision) => {
          const name =
            event.plan.steps.find((step) => step.id === decision.stepID)?.title ?? decision.stepID;
          const action = decision.verdict ?? (decision.edit ? 'edit and approve' : 'comment');
          return [
            `${name}: ${action}${decision.comment ? ` — ${decision.comment}` : ''}`,
            ...(decision.edit?.title !== undefined
              ? [`${name} title edit: ${decision.edit.title}`]
              : []),
            ...(decision.edit?.detail !== undefined
              ? [`${name} detail edit: ${decision.edit.detail}`]
              : []),
          ];
        }) ?? [];
      return {
        id: event.id,
        at: event.at,
        version: event.version,
        title: event.review?.action === 'execute' ? 'Execution approved' : 'Changes requested',
        details: [
          ...decisions,
          ...(event.review?.note ? [`Review note: ${event.review.note}`] : []),
        ],
      };
    }
    const title = {
      proposed: 'Plan proposed',
      amended: 'Plan amended',
      step: 'Step updated',
      checkpoint: 'Checkpoint reached',
      done: 'Run completed',
      touch: 'Files changed',
    }[event.reason];
    return {
      id: event.id,
      at: event.at,
      version: event.version,
      title,
      details: changed.length ? changed : [event.plan.summary],
    };
  });
}
