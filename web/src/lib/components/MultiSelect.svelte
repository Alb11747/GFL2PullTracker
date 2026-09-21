<script lang="ts">
  let {
    id,
    label,
    allLabel,
    options,
    value,
    onchange
  }: {
    id: string;
    label: string;
    allLabel: string;
    options: { value: string; label: string }[];
    value: string | string[];
    onchange: (value: string | string[]) => void;
  } = $props();
  let open = $state(false);
  let container: HTMLDetailsElement;
  let summary: HTMLElement;
  const selected = $derived(
    value === '' ? options.map((o) => o.value) : Array.isArray(value) ? value : [value]
  );
  const caption = $derived(
    value === ''
      ? allLabel
      : selected.length === 0
        ? 'None selected'
        : selected.length === 1
          ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
          : `${selected.length} selected`
  );
  function toggle(key: string, checked: boolean) {
    const next = options
      .filter((o) => (o.value === key ? checked : selected.includes(o.value)))
      .map((o) => o.value);
    onchange(next.length === options.length ? '' : next);
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (open && !container?.contains(event.target as Node)) open = false;
  }}
  onkeydown={(event) => {
    if (open && event.key === 'Escape') {
      open = false;
      summary?.focus();
    }
  }}
/>

<div class="multi-field">
  <span id={`${id}-label`}>{label}</span>
  <details bind:this={container} bind:open>
    <summary bind:this={summary} aria-labelledby={`${id}-label ${id}-value`}
      ><span id={`${id}-value`}>{caption}</span></summary
    >
    <div class="multi-menu">
      <div class="multi-actions">
        <button type="button" onclick={() => onchange('')}>Select all</button><button
          type="button"
          onclick={() => onchange([])}>Clear</button
        >
      </div>
      <fieldset>
        <legend class="sr-only">{label}</legend>
        {#each options as option (option.value)}
          <label
            ><input
              type="checkbox"
              checked={selected.includes(option.value)}
              onchange={(event) => toggle(option.value, event.currentTarget.checked)}
            />{option.label}</label
          >
        {/each}
        {#if !options.length}<p>No options in this profile.</p>{/if}
      </fieldset>
    </div>
  </details>
</div>

<style>
  .multi-field {
    display: flex;
    flex-direction: column;
    gap: 7px;
    min-width: 0;
    color: var(--muted);
    font-size: 0.8rem;
    font-weight: 600;
  }
  details {
    position: relative;
    color: var(--ink);
    font-weight: 400;
  }
  summary {
    min-height: 40px;
    padding: 9px 30px 9px 10px;
    border: 1px solid var(--control-line);
    border-radius: 3px;
    background: var(--white);
    cursor: pointer;
    list-style: none;
    position: relative;
    font-size: 0.95rem;
  }
  summary span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary::after {
    content: '';
    position: absolute;
    right: 12px;
    top: 14px;
    width: 6px;
    height: 6px;
    border-bottom: 1.5px solid currentColor;
    border-right: 1.5px solid currentColor;
    transform: rotate(45deg);
  }
  details[open] summary {
    border-color: var(--accent-text);
  }
  .multi-menu {
    position: absolute;
    inset-inline-start: 0;
    top: calc(100% + 5px);
    width: max-content;
    min-width: 100%;
    max-width: min(310px, calc(100vw - 48px));
    background: var(--white);
    box-shadow: 0 6px 18px #20252b26;
    padding: 8px;
    z-index: 10;
  }
  .multi-actions {
    display: flex;
    justify-content: space-between;
    border-bottom: 1px solid var(--line);
    gap: 12px;
  }
  .multi-actions button {
    border: 0;
    padding: 5px;
    min-height: 34px;
    font-size: 0.8rem;
    color: var(--accent-text);
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 4px 0 0;
    max-height: 260px;
    overflow: auto;
  }
  fieldset label {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 9px;
    padding: 7px 5px;
    min-height: 36px;
    color: var(--ink);
    font-weight: 400;
    cursor: pointer;
  }
  fieldset label:hover {
    background: var(--surface);
  }
  input {
    width: 16px;
    height: 16px;
    min-height: 0;
    margin: 0;
    padding: 0;
    accent-color: var(--accent-text);
    flex-shrink: 0;
  }
  p {
    padding: 8px;
  }
</style>
