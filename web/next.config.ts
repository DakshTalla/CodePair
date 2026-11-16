import type { NextConfig } from 'next';

const config: NextConfig = {
  // WHY off: strict mode mounts every component twice in development, which
  // would open and immediately close a WebSocket on every page load.
  reactStrictMode: false,
  // Hides the floating Next.js badge, which sat on top of the replay controls.
  devIndicators: false,
};

export default config;
