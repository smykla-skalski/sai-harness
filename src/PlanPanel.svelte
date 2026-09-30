<script lang="ts">
  import { Badge, Button } from '@smykla-skalski/sui';
  import Diagram from './Diagram.svelte';
  import {
    answerQuestions,
    reviewPlan,
    type PlanDecision,
    type PlanQuestion,
    type PlanQuestions,
    type PlanSnapshot,
  } from './lib/plan';
  import type { OpenCodeClient } from './lib/opencode';

  interface Props {
    snapshot: PlanSnapshot;
    client: OpenCodeClient | null;
    directory: string;
    sessionID: string | null;
    dark: boolean;
    onchanged: () => Promise<void>;
  }

  let { snapshot, client, directory, sessionID, dark, onchanged }: Props = $props();
  let decisions = $state<Record<string, PlanDecision>>({});
  let answers = $state<Record<string, string[]>>({});
  let questionErrors = $state<Record<string, string>>({});
  let answerStatus = $state<'editing' | 'sending' | 'answered' | 'superseded'>('editing');
  let lastOutcome = $state<{ status: 'answered' | 'superseded'; id: string } | null>(null);
  let staleDraft = $state<{ questions: PlanQuestion[]; answers: Record<string, string[]> } | null>(
    null,
  );
  let note = $state('');
  let pending = $state(false);
  let error = $state('');
  let currentPlan = '';
  let currentQuestions = '';
  let currentScope = '';
  let currentBatch: PlanQuestions | null = null;

  let plan = $derived(snapshot.plan);
  let questions = $derived(snapshot.questions);
  let canExecute = $derived(
    !!plan &&
      plan.steps.every((step) =>
        decisions[step.id]?.verdict
          ? ['approve', 'reject'].includes(decisions[step.id].verdict ?? '')
          : ['approved', 'in_progress', 'done', 'blocked', 'skipped', 'rejected'].includes(
              step.status,
            ),
      ) &&
      plan.steps.some(
        (step) =>
          decisions[step.id]?.verdict === 'approve' ||
          (decisions[step.id]?.verdict !== 'reject' &&
            ['approved', 'in_progress', 'blocked'].includes(step.status)),
      ),
  );

  $effect(() => {
    const key = plan ? `${plan.sessionID}:${plan.version}` : '';
    if (key !== currentPlan) {
      currentPlan = key;
      decisions = {};
      note = '';
    }
  });

  function scopeKey(path: string, id: string) {
    return `${encodeURIComponent(path)}:${encodeURIComponent(id)}`;
  }

  function draftKey(scope: string, id: string) {
    return `sai-questions-draft:${scope}:${encodeURIComponent(id)}`;
  }

  function loadAnswers(scope: string, id: string): Record<string, string[]> {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(draftKey(scope, id)) ?? '{}');
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
      return Object.fromEntries(
        Object.entries(stored).filter(
          (entry): entry is [string, string[]] =>
            Array.isArray(entry[1]) && entry[1].every((value) => typeof value === 'string'),
        ),
      );
    } catch {
      return {};
    }
  }

  function saveDraft(scope: string, id: string, draft: Record<string, string[]>) {
    localStorage.setItem(draftKey(scope, id), JSON.stringify(draft));
  }

  function saveOutcome(
    scope: string,
    batch: PlanQuestions,
    draft: Record<string, string[]>,
    status: 'answered' | 'superseded',
  ) {
    const outcome = { status, id: batch.id };
    localStorage.setItem(`sai-questions-outcome:${scope}`, JSON.stringify(outcome));
    if (status === 'superseded') {
      const preserved = { questions: batch.questions, answers: draft };
      localStorage.setItem(`sai-questions-stale:${scope}`, JSON.stringify(preserved));
      if (scope === currentScope) staleDraft = preserved;
    }
    if (scope === currentScope) lastOutcome = outcome;
  }

  $effect(() => {
    const scope = sessionID ? scopeKey(directory, sessionID) : '';
    if (scope !== currentScope) {
      currentScope = scope;
      currentQuestions = '';
      currentBatch = null;
      questionErrors = {};
      try {
        lastOutcome = JSON.parse(localStorage.getItem(`sai-questions-outcome:${scope}`) ?? 'null');
        staleDraft = JSON.parse(localStorage.getItem(`sai-questions-stale:${scope}`) ?? 'null');
      } catch {
        lastOutcome = null;
        staleDraft = null;
      }
    }
    const batch = questions?.sessionID === sessionID ? questions : null;
    const key = batch ? `${scope}:${batch.id}` : '';
    if (key !== currentQuestions) {
      if (currentBatch && answerStatus === 'editing')
        saveOutcome(scope, currentBatch, answers, 'superseded');
      currentQuestions = key;
      currentBatch = batch;
      answers = batch ? loadAnswers(scope, batch.id) : {};
      questionErrors = {};
      answerStatus = 'editing';
    }
  });

  function setDecision(stepID: string, verdict: PlanDecision['verdict']) {
    decisions[stepID] = { ...decisions[stepID], stepID, verdict };
  }

  function setComment(stepID: string, comment: string) {
    decisions[stepID] = { ...decisions[stepID], stepID, comment };
  }

  function setAnswer(id: string, value: string, multi: boolean) {
    const current = answers[id] ?? [];
    answers[id] = multi
      ? current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value]
      : [value];
    questionErrors[id] = '';
    if (questions) saveDraft(currentScope, questions.id, answers);
  }

  function setText(id: string, value: string) {
    answers[id] = value ? [value] : [];
    questionErrors[id] = '';
    if (questions) saveDraft(currentScope, questions.id, answers);
  }

  function questionOptions(question: PlanQuestion) {
    return question.kind === 'confirm'
      ? [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ]
      : (question.options ?? []);
  }

  function recommendation(question: PlanQuestion): string {
    const options = questionOptions(question);
    return (question.recommended ?? [])
      .map((value) => options.find((option) => option.value === value)?.label ?? value)
      .join(', ');
  }

  async function sendAnswers() {
    if (!client || !questions || questions.sessionID !== sessionID || pending) return;
    const batch = questions;
    const scope = currentScope;
    const draft = structuredClone(answers);
    const validated: Record<string, string[]> = {};
    const errors: Record<string, string> = {};
    for (const question of batch.questions) {
      const selected = draft[question.id] ?? [];
      if (question.kind === 'text') {
        const text = selected[0]?.trim() ?? '';
        if (!text) errors[question.id] = 'Enter an answer.';
        else validated[question.id] = [text];
      } else {
        const options = new Set(questionOptions(question).map((option) => option.value));
        if (
          !selected.length ||
          (question.kind !== 'multi' && selected.length !== 1) ||
          selected.some((value) => !options.has(value))
        )
          errors[question.id] = 'Choose a valid answer.';
        else validated[question.id] = [...new Set(selected)];
      }
    }
    questionErrors = errors;
    if (Object.keys(errors).length) return;
    pending = true;
    answerStatus = 'sending';
    error = '';
    try {
      await answerQuestions(client, directory, batch.sessionID, batch.id, validated);
      saveOutcome(scope, batch, draft, 'answered');
      if (scope === currentScope && questions?.id === batch.id) answerStatus = 'answered';
      await onchanged();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (scope === currentScope && questions?.id === batch.id) error = message;
      if (message.includes('no longer pending')) {
        saveOutcome(scope, batch, draft, 'superseded');
        if (scope === currentScope && questions?.id === batch.id) answerStatus = 'superseded';
        await onchanged().catch(() => {});
      } else if (scope === currentScope && questions?.id === batch.id) answerStatus = 'editing';
    } finally {
      pending = false;
    }
  }

  async function sendReview(action: 'revise' | 'execute') {
    if (!client || !plan) return;
    pending = true;
    error = '';
    try {
      await reviewPlan(
        client,
        directory,
        plan,
        action,
        Object.values(decisions),
        note.trim() || undefined,
      );
      await onchanged();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      pending = false;
    }
  }
</script>

<aside class="plan-panel" aria-label="Plan review">
  <div class="panel-heading">
    <div>
      <p class="eyebrow">PLAN WORKSPACE</p>
      <h2>Review</h2>
    </div>
    {#if plan}<Badge tone={plan.state === 'review' ? 'warning' : 'success'}
        >v{plan.version} · {plan.state}</Badge
      >{/if}
  </div>

  {#if error}<p class="panel-error" role="alert">{error}</p>{/if}
  {#if answerStatus === 'sending' && questions}<p class="question-state" role="status">
      Sending answers…
    </p>{/if}
  {#if lastOutcome}<p class="question-state" role="status">
      {lastOutcome.status === 'answered'
        ? 'Answers sent.'
        : 'A question batch was superseded. Your draft was kept.'}
    </p>{/if}
  {#if lastOutcome?.status === 'superseded' && staleDraft}<details class="stale-answers">
      <summary>View saved answers from the superseded batch</summary>
      {#each staleDraft.questions as oldQuestion (oldQuestion.id)}<p>
          <strong>{oldQuestion.question}</strong>: {(staleDraft.answers[oldQuestion.id] ?? []).join(
            ', ',
          ) || 'No answer'}
        </p>{/each}
    </details>{/if}

  {#if questions}
    <div class="panel-scroll">
      <h3>Questions before planning</h3>
      <p class="muted">
        Answer every question before sending. Recommendations are suggestions until you select them.
      </p>
      {#each questions.questions as question, index (question.id)}
        <section class="question-block">
          <h4><span>{index + 1}.</span> {question.question}</h4>
          {#if question.recommended?.length}<p class="question-recommendation">
              Recommended: {recommendation(question)}
            </p>{/if}
          {#if question.kind === 'text'}
            <textarea
              rows="3"
              placeholder="Your answer"
              value={answers[question.id]?.[0] ?? ''}
              aria-invalid={!!questionErrors[question.id]}
              disabled={pending}
              oninput={(event) => setText(question.id, event.currentTarget.value)}></textarea>
          {:else}
            {#each questionOptions(question) as option (option.value)}
              <label class="answer-option">
                <input
                  type={question.kind === 'multi' ? 'checkbox' : 'radio'}
                  name={question.id}
                  checked={(answers[question.id] ?? []).includes(option.value)}
                  disabled={pending}
                  onchange={() => setAnswer(question.id, option.value, question.kind === 'multi')}
                />
                <span
                  ><strong>{option.label}</strong
                  >{#if 'description' in option && option.description}<small
                      >{option.description}</small
                    >{/if}</span
                >
              </label>
            {/each}
          {/if}
          {#if questionErrors[question.id]}<p class="question-error" role="alert">
              {questionErrors[question.id]}
            </p>{/if}
        </section>
      {/each}
    </div>
    <div class="panel-actions">
      <Button onclick={sendAnswers} disabled={pending} loading={pending}>Send answers</Button>
    </div>
  {:else if plan}
    <div class="panel-scroll">
      <h3>{plan.title}</h3>
      <p class="summary">{plan.summary}</p>
      {#if plan.diagram}<Diagram source={plan.diagram} {dark} />{/if}

      {#if plan.alternatives?.length}
        <div class="subheading">Approaches</div>
        {#each plan.alternatives as alternative, index (index)}
          <div class="alternative">
            <strong>{alternative.name}</strong>{#if alternative.chosen}<Badge tone="success"
                >Chosen</Badge
              >{/if}{#if alternative.pros.length}<p>
                <b>Pros</b>
                {alternative.pros.join(' · ')}
              </p>{/if}{#if alternative.cons.length}<p>
                <b>Cons</b>
                {alternative.cons.join(' · ')}
              </p>{/if}
          </div>
        {/each}
      {/if}

      <div class="subheading">Steps <span>{plan.steps.length}</span></div>
      {#each plan.steps as step, index (step.id)}
        <section class="step-card">
          <div class="step-head">
            <span class="step-number">{String(index + 1).padStart(2, '0')}</span>
            <h4>{step.title}</h4>
            <Badge
              tone={step.risk === 'high'
                ? 'danger'
                : step.risk === 'medium'
                  ? 'warning'
                  : 'neutral'}>{step.risk}</Badge
            ><Badge
              tone={step.status === 'done' || step.status === 'approved'
                ? 'success'
                : step.status === 'blocked' || step.status === 'rejected'
                  ? 'danger'
                  : 'neutral'}>{step.status}</Badge
            >
          </div>
          <p>{step.detail}</p>
          {#if step.rationale}<p class="rationale">Why: {step.rationale}</p>{/if}
          {#if step.needsYou}<p class="decision-prompt">Decision: {step.needsYou}</p>{/if}
          {#if step.diagram}<Diagram source={step.diagram} {dark} />{/if}
          {#if step.files.length}<p class="files">{step.files.join(' · ')}</p>{/if}
          {#if plan.state === 'review'}
            <div class="decision-buttons">
              <Button
                size="sm"
                variant={decisions[step.id]?.verdict === 'approve' ? 'primary' : 'secondary'}
                onclick={() => setDecision(step.id, 'approve')}>Approve</Button
              >
              <Button
                size="sm"
                variant={decisions[step.id]?.verdict === 'revise' ? 'primary' : 'secondary'}
                onclick={() => setDecision(step.id, 'revise')}>Revise</Button
              >
              <Button
                size="sm"
                variant={decisions[step.id]?.verdict === 'reject' ? 'danger' : 'secondary'}
                onclick={() => setDecision(step.id, 'reject')}>Reject</Button
              >
            </div>
            {#if decisions[step.id]?.verdict === 'revise' || decisions[step.id]?.verdict === 'reject'}
              <textarea
                rows="2"
                placeholder="What should change?"
                value={decisions[step.id]?.comment ?? ''}
                oninput={(event) => setComment(step.id, event.currentTarget.value)}></textarea>
            {/if}
          {/if}
        </section>
      {/each}
      {#if plan.state === 'review'}<textarea
          class="review-note"
          rows="2"
          placeholder="General feedback for the architect (optional)"
          bind:value={note}></textarea>{/if}
    </div>
    {#if plan.state === 'review'}
      <div class="panel-actions split">
        <Button variant="secondary" onclick={() => sendReview('revise')} loading={pending}
          >Request changes</Button
        >
        <Button onclick={() => sendReview('execute')} disabled={!canExecute} loading={pending}
          >Execute plan</Button
        >
      </div>
    {/if}
  {:else}
    <div class="panel-empty">
      <div class="panel-empty-mark">◇</div>
      <h3>Your plan appears here</h3>
      <p>
        Start a conversation with the architect. Diagrams, questions, and step decisions will appear
        alongside the chat.
      </p>
    </div>
  {/if}
</aside>

<style>
  .plan-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    background: var(--sui-surface);
    border-left: 1px solid var(--shell-divider);
  }
  .panel-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 20px;
    border-bottom: 1px solid var(--shell-divider);
  }
  .eyebrow {
    margin: 0 0 3px;
    color: var(--sui-primary);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  h3 {
    margin: 0 0 8px;
    font-size: 16px;
  }
  h4 {
    margin: 0;
    font-size: 14px;
  }
  .panel-scroll {
    flex: 1;
    overflow: auto;
    padding: 20px;
  }
  .summary,
  .muted {
    margin: 0 0 18px;
    color: var(--sui-muted);
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
  }
  .subheading {
    display: flex;
    justify-content: space-between;
    margin: 24px 0 10px;
    color: var(--sui-muted);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .alternative {
    padding: 12px 0;
    border-bottom: 1px solid var(--shell-divider);
    font-size: 13px;
  }
  .alternative :global(.sui-badge) {
    margin-left: 8px;
  }
  .alternative p {
    margin: 5px 0 0;
    color: var(--sui-muted);
  }
  .step-card,
  .question-block {
    padding: 16px 0;
    border-top: 1px solid var(--shell-divider);
  }
  .step-head {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .step-head h4 {
    flex: 1;
  }
  .step-number {
    color: var(--sui-primary);
    font-size: 11px;
    font-weight: 700;
  }
  .step-card > p {
    margin: 10px 0;
    color: var(--sui-muted);
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .step-card .decision-prompt {
    color: var(--sui-foreground);
    font-weight: 600;
  }
  .step-card .files {
    font-family: ui-monospace, monospace;
    font-size: 11px;
  }
  .decision-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 14px;
  }
  .question-block h4 {
    margin-bottom: 12px;
    line-height: 1.45;
  }
  .question-block h4 span {
    color: var(--sui-primary);
  }
  .question-recommendation,
  .question-state,
  .stale-answers {
    margin: 8px 20px;
    color: var(--sui-muted);
    font-size: 12px;
  }
  .question-recommendation {
    margin: 0 0 12px;
  }
  .question-error {
    color: var(--sui-danger);
    font-size: 12px;
  }
  .stale-answers p {
    overflow-wrap: anywhere;
  }
  .answer-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px;
    border: 1px solid var(--shell-divider);
    border-radius: 8px;
    margin-bottom: 7px;
    cursor: pointer;
  }
  .answer-option input {
    accent-color: var(--sui-primary);
    margin-top: 3px;
  }
  .answer-option strong {
    display: block;
    font-size: 13px;
  }
  .answer-option small {
    display: block;
    color: var(--sui-muted);
    margin-top: 2px;
  }
  textarea {
    width: 100%;
    margin-top: 12px;
    padding: 10px 12px;
    resize: vertical;
    border: 1px solid var(--sui-border);
    border-radius: 8px;
    color: var(--sui-foreground);
    background: var(--sui-surface);
    font: 13px/1.5 var(--sui-font);
  }
  textarea:focus {
    outline: 2px solid var(--sui-focus);
    outline-offset: 1px;
  }
  .review-note {
    margin-top: 20px;
  }
  .panel-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 16px 20px;
    border-top: 1px solid var(--shell-divider);
  }
  .panel-actions.split {
    justify-content: space-between;
  }
  .panel-empty {
    margin: auto;
    max-width: 290px;
    padding: 30px;
    text-align: center;
  }
  .panel-empty-mark {
    color: var(--sui-primary);
    font-size: 42px;
  }
  .panel-empty p {
    color: var(--sui-muted);
    font-size: 13px;
    line-height: 1.5;
  }
  .panel-error {
    margin: 12px 20px 0;
    padding: 10px;
    color: var(--sui-danger-ink);
    background: var(--sui-danger-subtle);
    border-radius: 8px;
    font-size: 12px;
  }
</style>
