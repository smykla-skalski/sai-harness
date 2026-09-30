<script lang="ts">
  import {
    isFormAlreadySettledError,
    isFormNotFoundError,
    isPermissionNotFoundError,
    type FormField,
    type FormInfo,
    type PermissionRequest,
  } from '@opencode/client';
  import type { OpenCodeClient } from './lib/opencode';

  interface Props {
    pendingPermissions: PermissionRequest[];
    pendingForms: FormInfo[];
    client: OpenCodeClient | null;
    sessionID: string | null;
    onchanged: () => Promise<void>;
  }

  let { pendingPermissions, pendingForms, client, sessionID, onchanged }: Props = $props();
  type Value = string | number | boolean | string[];
  let drafts = $state<Record<string, Record<string, Value>>>({});
  let customInputs = $state<Record<string, string>>({});
  let feedback = $state<Record<string, string>>({});
  let busyID = $state<string | null>(null);
  let error = $state('');
  let status = $state('');

  $effect(() => {
    void sessionID;
    busyID = null;
    status = '';
    error = '';
  });

  $effect(() => {
    for (const form of pendingForms) {
      if (drafts[form.id]) continue;
      drafts[form.id] = Object.fromEntries(
        form.fields.flatMap((field) =>
          field.type === 'external'
            ? []
            : [[field.key, field.default ?? (field.type === 'multiselect' ? [] : '')]],
        ),
      );
    }
  });

  function value(form: FormInfo, key: string): Value {
    return drafts[form.id]?.[key] ?? '';
  }

  function setValue(form: FormInfo, key: string, next: Value) {
    drafts[form.id] = { ...drafts[form.id], [key]: next };
  }

  function addCustom(form: FormInfo, key: string) {
    const id = `${form.id}:${key}`;
    const entry = customInputs[id]?.trim();
    const selected = value(form, key);
    if (!entry || !Array.isArray(selected) || selected.includes(entry)) return;
    setValue(form, key, [...selected, entry]);
    customInputs[id] = '';
  }

  function visible(form: FormInfo, field: FormField): boolean {
    if ('hidden' in field && field.hidden) return false;
    return (
      !('when' in field) ||
      !field.when?.length ||
      field.when.every((condition) => {
        const current = value(form, condition.key);
        const matches = Array.isArray(current)
          ? current.includes(String(condition.value))
          : typeof condition.value === 'number' && typeof current === 'string' && current !== ''
            ? Number(current) === condition.value
            : current === condition.value;
        return condition.op === 'eq' ? matches : !matches;
      })
    );
  }

  function externalUrl(raw: string): string | null {
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function answer(form: FormInfo): Record<string, Value> {
    const result: Record<string, Value> = {};
    for (const field of form.fields) {
      if ('hidden' in field && field.hidden) {
        if (field.default !== undefined) result[field.key] = field.default;
        continue;
      }
      if (field.type === 'external' || !visible(form, field)) continue;
      const current = value(form, field.key);
      if (field.type === 'number' || field.type === 'integer') {
        if (current === '') {
          if (field.required) throw new Error(`${field.title ?? field.key} is required.`);
          continue;
        }
        if (current === 'Infinity' || current === '-Infinity' || current === 'NaN') {
          result[field.key] = current;
          continue;
        }
        const parsed = Number(current);
        if (!Number.isFinite(parsed) || (field.type === 'integer' && !Number.isInteger(parsed)))
          throw new Error(`Enter a valid number for ${field.title ?? field.key}.`);
        if (typeof field.minimum === 'number' && parsed < field.minimum)
          throw new Error(`${field.title ?? field.key} must be at least ${field.minimum}.`);
        if (typeof field.maximum === 'number' && parsed > field.maximum)
          throw new Error(`${field.title ?? field.key} must be at most ${field.maximum}.`);
        result[field.key] = parsed;
      } else if (field.type === 'multiselect') {
        const entry = field.custom ? customInputs[`${form.id}:${field.key}`]?.trim() : undefined;
        const selected = Array.isArray(current) ? [...current] : [];
        if (entry && !selected.includes(entry)) selected.push(entry);
        if (selected.length < (field.minItems ?? (field.required ? 1 : 0)))
          throw new Error(`Choose more options for ${field.title ?? field.key}.`);
        if (field.maxItems !== undefined && selected.length > field.maxItems)
          throw new Error(`Choose fewer options for ${field.title ?? field.key}.`);
        result[field.key] = selected;
      } else if (field.type === 'boolean') {
        result[field.key] = current === true;
      } else {
        const text = String(current);
        if (field.required && !text.trim())
          throw new Error(`${field.title ?? field.key} is required.`);
        if (!text && !field.required) continue;
        if (field.minLength !== undefined && text.length < field.minLength)
          throw new Error(`${field.title ?? field.key} is too short.`);
        if (field.maxLength !== undefined && text.length > field.maxLength)
          throw new Error(`${field.title ?? field.key} is too long.`);
        if (field.pattern && text && !new RegExp(field.pattern).test(text))
          throw new Error(`${field.title ?? field.key} has an invalid format.`);
        result[field.key] = text;
      }
    }
    return result;
  }

  async function decide(request: PermissionRequest, decision: 'once' | 'always' | 'reject') {
    if (!client || !sessionID || request.sessionID !== sessionID) return;
    const source = client;
    const selected = sessionID;
    busyID = request.id;
    error = '';
    status = 'Sending permission decision…';
    try {
      await source.permission.get({ sessionID: selected, requestID: request.id });
      if (sessionID !== selected) return;
      await source.permission.reply({
        sessionID: selected,
        requestID: request.id,
        decision,
        ...(decision === 'reject' && feedback[request.id]?.trim()
          ? { message: feedback[request.id].trim() }
          : {}),
      });
      if (sessionID === selected)
        status = decision === 'reject' ? 'Permission rejected.' : 'Permission allowed.';
    } catch (cause) {
      if (sessionID === selected) {
        status = '';
        if (!isPermissionNotFoundError(cause)) error = describe(cause);
      }
    } finally {
      if (sessionID === selected) {
        busyID = null;
        await onchanged();
      }
    }
  }

  async function settle(form: FormInfo, action: 'reply' | 'cancel') {
    if (!client || !sessionID || form.sessionID !== sessionID) return;
    const source = client;
    const selected = sessionID;
    busyID = form.id;
    error = '';
    status = action === 'reply' ? 'Submitting form…' : 'Cancelling form…';
    try {
      const submitted = action === 'reply' ? answer(form) : null;
      const current = await source.session.form.get({ sessionID: selected, formID: form.id });
      if (sessionID !== selected || current.state.status !== 'pending') return;
      if (submitted)
        await source.session.form.reply({
          sessionID: selected,
          formID: form.id,
          answer: submitted,
        });
      else await source.session.form.cancel({ sessionID: selected, formID: form.id });
      if (sessionID === selected)
        status = action === 'reply' ? 'Form submitted.' : 'Form cancelled.';
    } catch (cause) {
      if (sessionID === selected) {
        status = '';
        if (!isFormNotFoundError(cause) && !isFormAlreadySettledError(cause))
          error = describe(cause);
      }
    } finally {
      if (sessionID === selected) {
        busyID = null;
        await onchanged();
      }
    }
  }

  function describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }
</script>

{#if pendingPermissions.length || pendingForms.length || status || error}
  <section class="prompt-panel" aria-label="Pending agent requests">
    {#if pendingPermissions.length || pendingForms.length}<h2>Agent requests</h2>{/if}
    {#if error}<p class="notice error" role="alert">{error}</p>{/if}
    {#if status}<p class="notice" role="status">{status}</p>{/if}
    {#each pendingPermissions as request (request.id)}
      <article class="prompt-card">
        <h3>Allow {request.action}?</h3>
        {#if request.message}<p>{request.message}</p>{/if}
        <ul>
          {#each request.resources as resource, index (`${resource}:${index}`)}<li>
              <code>{resource}</code>
            </li>{/each}
        </ul>
        <p class="prompt-warning">
          Allow always saves these approvals for this project:
          {#if request.save?.length}{#each request.save as pattern, index (`${pattern}:${index}`)}<code
                >{request.action}: {pattern}</code
              >{/each}
          {:else}<span>No saved pattern proposed.</span>{/if}
        </p>
        <p class="prompt-warning">Reject also rejects other pending permissions in this session.</p>
        <label
          >Optional rejection feedback
          <textarea
            value={feedback[request.id] ?? ''}
            oninput={(event) => (feedback[request.id] = event.currentTarget.value)}></textarea>
        </label>
        <div class="prompt-actions">
          <button disabled={!!busyID} onclick={() => decide(request, 'once')}>Allow once</button>
          <button disabled={!!busyID} onclick={() => decide(request, 'always')}>Allow always</button
          >
          <button disabled={!!busyID} onclick={() => decide(request, 'reject')}>Reject</button>
        </div>
      </article>
    {/each}
    {#each pendingForms as form (form.id)}
      <article class="prompt-card">
        <h3>{form.title}</h3>
        {#each form.fields as field (field.key)}
          {#if visible(form, field)}
            <div class="prompt-field" role="group" aria-label={field.title ?? field.key}>
              <strong>{field.title ?? field.key}</strong>{#if 'required' in field && field.required}
                *{/if}
              {#if 'description' in field && field.description}<small>{field.description}</small
                >{/if}
              {#if field.type === 'external'}
                {#if externalUrl(field.url)}<a
                    href={externalUrl(field.url)}
                    target="_blank"
                    rel="noopener noreferrer">Open link</a
                  >{:else}<span>Unsupported link</span>{/if}
              {:else if field.type === 'boolean'}<input
                  type="checkbox"
                  aria-label={field.title ?? field.key}
                  checked={value(form, field.key) === true}
                  onchange={(event) => setValue(form, field.key, event.currentTarget.checked)}
                />
              {:else if field.type === 'multiselect'}
                {#each field.options as option (option.value)}<label class="prompt-option"
                    ><input
                      type="checkbox"
                      aria-label={option.label}
                      checked={Array.isArray(value(form, field.key)) &&
                        (value(form, field.key) as string[]).includes(option.value)}
                      onchange={(event) => {
                        const selected = value(form, field.key) as string[];
                        setValue(
                          form,
                          field.key,
                          event.currentTarget.checked
                            ? [...selected, option.value]
                            : selected.filter((item) => item !== option.value),
                        );
                      }}
                    />{option.label}</label
                  >{/each}
                {#if field.custom}
                  {#each (value(form, field.key) as string[]).filter((item) => !field.options.some((option) => option.value === item)) as item (item)}
                    <button
                      type="button"
                      class="prompt-custom-option"
                      aria-label={`Remove ${item}`}
                      onclick={() =>
                        setValue(
                          form,
                          field.key,
                          (value(form, field.key) as string[]).filter(
                            (selected) => selected !== item,
                          ),
                        )}>{item} ×</button
                    >
                  {/each}
                  <div class="prompt-custom-entry">
                    <input
                      aria-label={`Custom ${field.title ?? field.key}`}
                      value={customInputs[`${form.id}:${field.key}`] ?? ''}
                      oninput={(event) =>
                        (customInputs[`${form.id}:${field.key}`] = event.currentTarget.value)}
                    />
                    <button type="button" onclick={() => addCustom(form, field.key)}>Add</button>
                  </div>
                {/if}
              {:else if field.type === 'string' && field.options?.length && !field.custom}
                <select
                  aria-label={field.title ?? field.key}
                  value={String(value(form, field.key))}
                  onchange={(event) => setValue(form, field.key, event.currentTarget.value)}
                >
                  <option value="">Choose…</option
                  >{#each field.options as option (option.value)}<option value={option.value}
                      >{option.label}</option
                    >{/each}
                </select>
              {:else}<input
                  type={field.type === 'string'
                    ? field.format === 'uri'
                      ? 'url'
                      : field.format === 'date-time'
                        ? 'text'
                        : (field.format ?? 'text')
                    : 'text'}
                  aria-label={field.title ?? field.key}
                  inputmode={field.type === 'number' || field.type === 'integer'
                    ? 'decimal'
                    : undefined}
                  list={field.type === 'string' && field.custom && field.options?.length
                    ? `options-${form.id}-${field.key}`
                    : undefined}
                  value={String(value(form, field.key))}
                  placeholder={field.type === 'string' ? (field.placeholder ?? '') : ''}
                  oninput={(event) => setValue(form, field.key, event.currentTarget.value)}
                />
                {#if field.type === 'string' && field.custom && field.options?.length}
                  <datalist id={`options-${form.id}-${field.key}`}>
                    {#each field.options as option (option.value)}<option value={option.value}
                        >{option.label}</option
                      >{/each}
                  </datalist>
                {/if}
              {/if}
            </div>
          {/if}
        {/each}
        <div class="prompt-actions">
          <button disabled={!!busyID} onclick={() => settle(form, 'reply')}>Submit</button>
          <button disabled={!!busyID} onclick={() => settle(form, 'cancel')}>Cancel</button>
        </div>
      </article>
    {/each}
  </section>
{/if}
