import path from 'node:path';
import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://localhost:4200';

const nextConfig: NextConfig = {
  // The Docker image runs the self-contained server; locally `next start` is used.
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  // Monorepo root, so the standalone build includes workspace packages.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@convo/shared'],
  poweredByHeader: false,
  agentRules: false,
  // The browser only ever talks to this origin. /api/* is forwarded to the Express API,
  // which keeps the auth cookies first-party and avoids CORS entirely.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
