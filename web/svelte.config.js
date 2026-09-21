import adapter from '@sveltejs/adapter-node';
export default {
  kit: {
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
