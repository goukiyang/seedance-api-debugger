const distDir = process.env.NEXT_DIST_DIR?.trim();

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(distDir ? { distDir } : {}),

  images: { unoptimized: true },
  async rewrites() {
    // beforeFiles also shadows old tracked videos until D2 is decided.
    return { beforeFiles: [
      { source: '/uploads/:path*', destination: '/api/media/legacy?path=/uploads/:path*' },
      { source: '/videos/:path*', destination: '/api/media/legacy?path=/videos/:path*' },
    ], afterFiles: [], fallback: [] };
  },

  async headers() {
    return [
      {
        source: '/storage/:path*',
        headers: [
          {
            key: 'Cross-Origin-Resource-Policy',
            value: 'cross-origin',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
