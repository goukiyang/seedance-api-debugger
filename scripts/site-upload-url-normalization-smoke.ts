import assert from 'node:assert/strict';
import {
  resolveSitePublicBaseUrl,
  sameOriginPublicUrlForSiteUpload,
  siteUploadPathFromUrl,
} from '../src/lib/assets/site-url';

const mutableEnv = process.env as Record<string, string | undefined>;

const previousEnv: Record<string, string | undefined> = {
  SITE_PUBLIC_BASE_URL: process.env.SITE_PUBLIC_BASE_URL,
  BASE_URL: process.env.BASE_URL,
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
  NODE_ENV: process.env.NODE_ENV,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete mutableEnv[key];
    else mutableEnv[key] = value;
  }
}

function resetEnv() {
  delete process.env.SITE_PUBLIC_BASE_URL;
  delete process.env.BASE_URL;
  delete process.env.NEXTAUTH_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  mutableEnv.NODE_ENV = 'test';
}

try {
  resetEnv();
  process.env.BASE_URL = 'https://sd2.youdooart.com';
  process.env.NEXT_PUBLIC_BASE_URL = 'https://sd2.youdoodesign.com';
  assert.equal(resolveSitePublicBaseUrl(), 'https://sd2.youdooart.com');
  assert.equal(
    sameOriginPublicUrlForSiteUpload('https://sd2.youdoodesign.com/uploads/assets/demo.png'),
    'https://sd2.youdooart.com/uploads/assets/demo.png',
  );
  assert.equal(
    sameOriginPublicUrlForSiteUpload('/uploads/thumbs/demo_thumb.png'),
    'https://sd2.youdooart.com/uploads/thumbs/demo_thumb.png',
  );
  assert.equal(
    siteUploadPathFromUrl('https://sd2.youdoodesign.com/uploads/assets/demo.png?stale=1'),
    '/uploads/assets/demo.png',
  );

  resetEnv();
  process.env.NEXT_PUBLIC_BASE_URL = 'https://sd2.youdoodesign.com';
  assert.equal(
    resolveSitePublicBaseUrl(),
    'https://sd2.youdooart.com',
    '旧公开域名是 410 入口，不能继续当作当前站点公开基准域名',
  );

  resetEnv();
  process.env.BASE_URL = 'http://localhost:3000';
  process.env.NEXTAUTH_URL = 'https://sd2.youdooart.com';
  assert.equal(resolveSitePublicBaseUrl(), 'https://sd2.youdooart.com');
  assert.equal(siteUploadPathFromUrl('https://assets.example.com/uploads/assets/demo.png'), null);
} finally {
  restoreEnv();
}
