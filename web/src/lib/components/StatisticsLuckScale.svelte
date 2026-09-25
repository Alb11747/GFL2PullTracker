<script lang="ts">
  let { tail, source }: { tail: number; source: string } = $props();
  const position = $derived(Math.max(0, Math.min(100, (1 - tail) * 100)));
</script>

<div
  class="luck-scale"
  role="img"
  aria-label={`${source}: ${position.toFixed(1)}% of outcomes were strictly below yours; equal outcomes are not included.`}
>
  <div class="luck-track" aria-hidden="true">
    <span class="luck-fill" style:width={`${position}%`}></span><span
      class="luck-marker"
      style:left={`${position}%`}
    ></span>
  </div>
  <div class="luck-scale-labels" aria-hidden="true">
    <span>Less lucky</span><span>50%</span><span>Luckier</span>
  </div>
</div>

<style>
  .luck-scale {
    margin: 12px 0 8px;
  }
  .luck-track {
    height: 6px;
    background: #c3c9d0;
    position: relative;
  }
  .luck-track::after {
    content: '';
    position: absolute;
    left: 50%;
    top: -2px;
    height: 10px;
    border-left: 1px solid #7a8591;
  }
  .luck-fill {
    display: block;
    height: 100%;
    background: var(--luck-color, #a64000);
  }
  .luck-marker {
    position: absolute;
    top: -3px;
    width: 2px;
    height: 12px;
    transform: translateX(-1px);
    background: #20252b;
    z-index: 1;
  }
  .luck-scale-labels {
    display: flex;
    justify-content: space-between;
    gap: 4px;
    margin-top: 7px;
    font-size: 12px;
    color: #555e68;
  }
  .luck-scale-labels span {
    white-space: nowrap;
  }
  @media (max-width: 650px) {
    .luck-scale-labels span:nth-child(2) {
      display: none;
    }
  }
</style>
