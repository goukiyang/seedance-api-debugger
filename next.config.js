/** @type {import('next').NextConfig} */
const nextConfig = {
  // 允许访问 public 目录下的上传文件
  // 文件保存到 public/uploads/，通过 /uploads/... 路径访问

  // 开发环境：确保上传目录存在
  webpack: (config, { dev }) => {
    if (dev) {
      const path = require('path');
      const fs = require('fs');
      const uploadDir = path.join(process.cwd(), 'public', 'uploads');
      ['uploads', 'uploads/assets', 'uploads/thumbs'].forEach((sub) => {
        const dir = path.join(process.cwd(), 'public', sub);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      });
    }
    return config;
  },

  async headers() {
    return [
      {
        source: '/uploads/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: 'cross-origin',
          },
        ],
      },
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
