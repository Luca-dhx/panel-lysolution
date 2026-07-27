// Primitives de secret du Panel :
//  - sha256Hex : empreinte servant aux vérifications entrantes (codes, tokens) ;
//  - encryptSecret / decryptSecret : AES-256-GCM au repos pour la copie du
//    bridgeToken réservée aux appels sortants (ProjectBridgeClient) ;
//  - timingSafeEqualHex : comparaison en temps constant de deux empreintes.
import crypto from 'node:crypto';
import config from '../config/env.js';

const KEY = Buffer.from(config.bridgeEncryptionKey, 'hex');

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${encrypted.toString('hex')}`;
}

export function decryptSecret(payload) {
  const [ivHex, tagHex, dataHex] = String(payload).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
