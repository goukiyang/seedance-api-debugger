import { isAcceleratedVideoDeliveryProvider } from '@/lib/video/public-delivery';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

assertEqual(isAcceleratedVideoDeliveryProvider('r2'), true, 'R2 should be treated as accelerated video delivery');
assertEqual(isAcceleratedVideoDeliveryProvider('tos'), true, 'TOS should be treated as accelerated video delivery');
assertEqual(isAcceleratedVideoDeliveryProvider('local'), false, 'Local storage should remain a slow fallback');
assertEqual(isAcceleratedVideoDeliveryProvider('local-public'), false, 'Site public folder should remain a slow fallback by default');
assertEqual(
  isAcceleratedVideoDeliveryProvider('local-public', { allowLocalPublic: true }),
  true,
  'Local public storage can be explicitly allowed for controlled deployments',
);

console.log('video public delivery rules ok');
