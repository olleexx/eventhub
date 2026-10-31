import { config } from '../../config/env.js';
import { bachsGateway, GatewayError } from './bachs.js';
import { mockGateway } from './mock.js';

/** The single seam between the application and a payment provider. */
export function getGateway() {
  if (config.PAYMENTS_DRIVER === 'mock') {
    if (config.isProd) throw new Error('mock gateway is not allowed in production');
    return mockGateway;
  }
  return bachsGateway;
}

export function webhookSecrets() {
  return [config.BACHS_WEBHOOK_SECRET, config.BACHS_WEBHOOK_SECRET_PREVIOUS].filter(Boolean);
}

export function paymentsStatus() {
  const mode = config.PAYMENTS_DRIVER === 'mock' ? 'mock' : config.bachsMode;
  return {
    driver: config.PAYMENTS_DRIVER,
    mode,
    configured: config.PAYMENTS_DRIVER === 'mock' || Boolean(config.BACHS_API_KEY),
    webhookSecretConfigured: Boolean(config.BACHS_WEBHOOK_SECRET),
    liveEnabled: config.BACHS_LIVE_ENABLED,
    canTakePayments: config.PAYMENTS_DRIVER === 'mock' || (Boolean(config.BACHS_API_KEY) && Boolean(config.BACHS_WEBHOOK_SECRET) && (mode === 'sandbox' || (mode === 'live' && config.BACHS_LIVE_ENABLED))),
  };
}

export { GatewayError };
