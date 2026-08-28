import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.meetmymenu.app',
  appName: 'Meet My Menu AI',
  webDir: 'dist',
  plugins: {
    // Native requests use absolute app.meetmymenu.com API URLs. Route them
    // through Capacitor's native HTTP layer so WKWebView CORS rules do not turn
    // successful Cartesia/chat responses into opaque network failures.
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
