import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Custom server handles Socket.IO — Next.js runs inside it
  // Do NOT use `output: 'standalone'` or edge runtime anywhere
  experimental: {
    // Server Actions enabled by default in Next.js 15
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'pps.whatsapp.net' },
      { protocol: 'https', hostname: '*.whatsapp.net' },
    ],
  },
};

export default nextConfig;
