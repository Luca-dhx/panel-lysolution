export const PANEL_PASSWORD_MIN_LENGTH = 10;

export function passwordPolicyMessage() {
  return `Au moins ${PANEL_PASSWORD_MIN_LENGTH} caractères.`;
}

export function isPasswordPolicyValid(password: string) {
  return password.length >= PANEL_PASSWORD_MIN_LENGTH;
}
