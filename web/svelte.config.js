import adapter from '@sveltejs/adapter-node';
const telemetryBuild = process.env.POSTHOG_SOURCEMAPS === '1';
const revision = process.env.GFL2_RELEASE;
if (telemetryBuild && !/^[a-f0-9]{40}$/.test(revision ?? '')) {
  throw new Error('Source-map builds require the deployed Git revision.');
}
export default {
  kit: {
    // CLI injection happens after Vite hashes assets. A release namespace prevents
    // immutable browser/CDN caches from serving bytes with another release's IDs.
    appDir: telemetryBuild ? `_app/${revision}` : '_app',
    adapter: adapter(),
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'script-src': ['self', 'https://accounts.google.com', 'https://us-assets.i.posthog.com'],
        'style-src': ['self', 'unsafe-inline', 'https://accounts.google.com'],
        'connect-src': [
          'self',
          'https://us.i.posthog.com',
          'https://us-assets.i.posthog.com',
          'https://www.googleapis.com',
          'https://accounts.google.com',
          'https://gf2-gacha-record-us.sunborngame.com',
          'https://gf2-gacha-record.sunborngame.com',
          'https://gf2-gacha-record-asia.haoplay.com',
          'https://gf2-gacha-record-jp.haoplay.com',
          'https://gf2-gacha-record-kr.haoplay.com',
          'https://gf2-gacha-record-intl.haoplay.com'
        ],
        'frame-src': ['https://accounts.google.com'],
        'img-src': ['self', 'data:'],
        'worker-src': ['self', 'blob:'],
        'object-src': ['none'],
        'base-uri': ['self'],
        'form-action': ['self'],
        'frame-ancestors': ['none']
      }
    }
  }
};
