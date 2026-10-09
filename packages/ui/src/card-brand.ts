import visa from './card-brands/visa.svg';
import mastercard from './card-brands/mc.svg';
import amex from './card-brands/amex.svg';
import unionpay from './card-brands/cup.svg';
import jcb from './card-brands/jcb.svg';
import discover from './card-brands/discover.svg';
import diners from './card-brands/diners.svg';
import maestro from './card-brands/maestro.svg';
import rupay from './card-brands/rupay.svg';

const BRANDS = {
  visa: { name: 'Visa', src: visa },
  mastercard: { name: 'Mastercard', src: mastercard },
  amex: { name: 'American Express', src: amex },
  unionpay: { name: 'UnionPay 银联', src: unionpay },
  jcb: { name: 'JCB', src: jcb },
  discover: { name: 'Discover', src: discover },
  diners: { name: 'Diners Club', src: diners },
  maestro: { name: 'Maestro', src: maestro },
  rupay: { name: 'RuPay', src: rupay },
} as const;
type Brand = keyof typeof BRANDS;
export const BUILTIN_CARD_ICONS = (Object.keys(BRANDS) as Brand[]).map(id => ({ id, ...BRANDS[id] }));
const ALIASES: Record<string, Brand> = {
  visa: 'visa', mastercard: 'mastercard', mc: 'mastercard', 万事达: 'mastercard',
  amex: 'amex', americanexpress: 'amex', 美国运通: 'amex', 运通: 'amex',
  unionpay: 'unionpay', chinaunionpay: 'unionpay', cup: 'unionpay', 银联: 'unionpay', 中国银联: 'unionpay',
  jcb: 'jcb', discover: 'discover', dinersclub: 'diners', diners: 'diners',
  maestro: 'maestro', rupay: 'rupay',
};

/** Network identity comes only from the saved brand, never from PAN/BIN lookups. */
export function cardBrandLogo(value: string | null | undefined) {
  if (!value) return null;
  const alias = value.normalize('NFKC').toLowerCase().replace(/[\s._-]+/g, '');
  const id = Object.hasOwn(ALIASES, alias) ? ALIASES[alias] : undefined;
  return id ? { id, ...BRANDS[id] } : null;
}
