'use strict';

const sharp = require('sharp');

// Deny the libvips loader family first: new plugins must not become allowed
// merely because a dependency update makes them available.
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: [
  'VipsForeignLoadJpeg',
  'VipsForeignLoadPng',
  'VipsForeignLoadWebp',
  'VipsForeignLoadNsgif',
  'VipsForeignLoadHeif',
  'VipsForeignLoadRaw',
] });

module.exports = sharp;
