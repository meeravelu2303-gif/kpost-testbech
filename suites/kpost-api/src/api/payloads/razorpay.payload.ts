import { faker } from '../../utils/dataGen';

export function buildGenerateOrderPayload(overrides: Record<string, unknown> = {}) {
  return {
    kpostId: `qa${faker.string.alphanumeric({ length: 8, casing: 'lower' })}`,
    amount: '10000',
    tinNumber: faker.string.alphanumeric(10).toUpperCase(),
    ...overrides,
  };
}

export function buildValidateTransactionPayload(overrides: Record<string, unknown> = {}) {
  return {
    kpostId: `qa${faker.string.alphanumeric({ length: 8, casing: 'lower' })}`,
    paymentOrderId: `order_${faker.string.alphanumeric(14)}`,
    paymentId: `pay_${faker.string.alphanumeric(14)}`,
    signature: faker.string.hexadecimal({ length: 64, prefix: '' }),
    tinNumber: faker.string.alphanumeric(10).toUpperCase(),
    amount: '10000',
    paidDate: new Date().toISOString(),
    ...overrides,
  };
}
