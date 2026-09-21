<script lang="ts">
  import LoadingRegion from '../../src/lib/components/LoadingRegion.svelte';
  import LoadingLabel from '../../src/lib/components/LoadingLabel.svelte';

  let busy = false;
  let height = 180;
  let width = 500;
  let message = 'Loading results…';
  let text = 'Saved results';
  let label = 'Refresh saved results';
  export function setState(next: {
    busy?: boolean;
    height?: number;
    width?: number;
    message?: string;
    text?: string;
    label?: string;
  }) {
    if (next.busy !== undefined) busy = next.busy;
    if (next.height !== undefined) height = next.height;
    if (next.width !== undefined) width = next.width;
    if (next.message !== undefined) message = next.message;
    if (next.text !== undefined) text = next.text;
    if (next.label !== undefined) label = next.label;
  }
</script>

<div style:width={`${width}px`} style:max-width="100%">
  <button><LoadingLabel {busy} {label} loadingLabel="Loading…" /></button>
  <LoadingRegion {busy} {message}>
    <div class="fixture-content" style:min-height={`${height}px`}>{text}</div>
  </LoadingRegion>
</div>
