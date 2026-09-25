/** Standalone component harness supplies the SvelteKit page boundary, with telemetry off. */
export const page = {
  data: { telemetry: { enabled: false } },
  get url() {
    return new URL(location.href);
  }
};
