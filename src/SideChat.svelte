<script lang="ts">
  import { onMount, tick } from 'svelte';
  import AgentWorkspace from './AgentWorkspace.svelte';
  import Markdown from './Markdown.svelte';
  import type { OpenCodeClient, SessionMessageInfo } from './lib/opencode';
  import type { AgentId } from './lib/acp';

  type Source =
    { kind: 'opencode'; sessionID: string } | { kind: 'acp'; agent: AgentId; context: string };

  let {
    source,
    client,
    directory,
    focused,
    focusPrompt,
    onpromptfocused,
  }: {
    source: Source;
    client: OpenCodeClient | null;
    directory: string;
    focused: boolean;
    focusPrompt: boolean;
    onpromptfocused: () => void;
  } = $props();

  let forkID = $state<string | null>(null);
  let loading = $state(false);
  let busy = $state(false);
  let error = $state('');
  let draft = $state('');
  let replies = $state<{ id: string; role: string; text: string }[]>([]);
  let baseline = new Set<string>();
  let inboxID: string | null = null;
  let prompt = $state<HTMLTextAreaElement>();
  let disposed = false;

  function messageText(message: SessionMessageInfo): string {
    return message.type === 'user'
      ? message.text
      : message.type === 'assistant'
        ? message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
        : '';
  }

  async function refresh() {
    if (!client || !forkID) return;
    const page = await client.message.list({ sessionID: forkID, limit: 100, order: 'desc' });
    if (disposed) return;
    replies = page.data
      .filter((message) => !baseline.has(message.id))
      .toReversed()
      .map((message) => ({ id: message.id, role: message.type, text: messageText(message) }))
      .filter((message) => message.text);
  }

  onMount(() => {
    disposed = false;
    if (source.kind === 'opencode' && client) {
      loading = true;
      void (async () => {
        try {
          const fork = await client.session.fork({ sessionID: source.sessionID });
          if (disposed) {
            await client.session.remove({ sessionID: fork.id });
            return;
          }
          forkID = fork.id;
          const page = await client.message.list({ sessionID: fork.id, limit: 100, order: 'desc' });
          baseline = new Set(page.data.map((message) => message.id));
        } catch (cause) {
          if (!disposed) error = String(cause);
        } finally {
          if (!disposed) loading = false;
        }
      })();
    }
    return () => {
      disposed = true;
      if (forkID && client) {
        const sessionID = forkID;
        const pending = inboxID;
        void (async () => {
          if (pending)
            await client.session.inbox.cancel({ sessionID, inboxID: pending }).catch(() => {});
          await client.session.remove({ sessionID }).catch(() => {});
        })();
      }
    };
  });

  $effect(() => {
    if (focusPrompt && focused && !loading && !busy && source.kind === 'opencode') {
      void tick().then(() => {
        prompt?.focus();
        onpromptfocused();
        return undefined;
      });
    }
  });

  async function send() {
    const text = draft.trim();
    if (!text || !client || !forkID || busy) return;
    busy = true;
    error = '';
    draft = '';
    try {
      const inbox = await client.session.prompt({ sessionID: forkID, text });
      if (disposed) {
        await client.session.inbox.cancel({ sessionID: forkID, inboxID: inbox.id }).catch(() => {});
        return;
      }
      inboxID = inbox.id;
      await client.session.wait({ sessionID: forkID });
      inboxID = null;
      await refresh();
    } catch (cause) {
      if (!disposed) {
        error = String(cause);
        draft = text;
      }
    } finally {
      if (!disposed) busy = false;
    }
  }
</script>

{#if source.kind === 'acp'}
  <AgentWorkspace
    agent={source.agent}
    agentName={source.agent}
    {directory}
    thread={null}
    running={false}
    {focused}
    {focusPrompt}
    {onpromptfocused}
    ephemeral
    seedContext={source.context}
    oncreated={() => {}}
    onactivity={() => {}}
    onstatus={() => {}}
    onterminal={() => {}}
  />
{:else}
  <div class="side-chat">
    <p class="side-chat-hint">Questions here stay out of the main thread.</p>
    <div class="side-chat-messages" aria-live="polite">
      {#each replies as reply (reply.id)}
        <div class="side-chat-message">
          <strong>{reply.role === 'user' ? 'You' : 'Agent'}</strong><Markdown source={reply.text} />
        </div>
      {/each}
      {#if loading}<p>Preparing side chat…</p>{/if}
      {#if busy}<p>Thinking…</p>{/if}
      {#if error}<p role="alert">{error}</p>{/if}
    </div>
    <div class="side-chat-composer">
      <textarea
        bind:this={prompt}
        bind:value={draft}
        data-pane-prompt
        aria-label="Side chat question"
        placeholder="Ask about this thread…"
        disabled={loading || busy || !forkID}
        onkeydown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void send();
          }
        }}></textarea>
      <button disabled={loading || busy || !draft.trim() || !forkID} onclick={() => void send()}
        >Send</button
      >
    </div>
  </div>
{/if}

<style>
  .side-chat {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    padding: 0.75rem;
    gap: 0.5rem;
  }
  .side-chat-hint {
    margin: 0;
    color: var(--text-muted, #888);
    font-size: 0.8rem;
  }
  .side-chat-messages {
    flex: 1;
    overflow: auto;
  }
  .side-chat-message {
    margin-bottom: 1rem;
  }
  .side-chat-message strong {
    display: block;
    margin-bottom: 0.25rem;
  }
  .side-chat-composer {
    display: flex;
    gap: 0.5rem;
  }
  textarea {
    flex: 1;
    min-height: 3rem;
    resize: vertical;
  }
</style>
