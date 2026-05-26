// Política de contraseña — espejo de saas-base/src/utils/passwordPolicy.js.
// Si actualizas aquí, actualiza también el del backend (y viceversa). El
// backend es la fuente de verdad — esto solo da feedback inmediato en UI.

export const MIN_LENGTH = 10

const COMMON_PASSWORDS = new Set([
  '123456', '12345678', '123456789', '1234567890', '12345', '1234567', '111111', '000000', '987654321',
  'password', 'password1', 'password12', 'password123', 'passw0rd', 'pass1234', 'p@ssw0rd', 'p@ssword',
  'qwerty', 'qwerty123', 'qwerty1234', 'qwertyuiop', 'qwerty12', 'asdfghjkl', 'zxcvbnm',
  'admin', 'admin123', 'admin1234', 'administrator', 'administrador',
  'root', 'root1234', 'toor', 'master', 'master123', 'guest', 'guest123',
  'welcome', 'welcome1', 'welcome123', 'login', 'login123', 'changeme', 'letmein', 'letmein123',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball', 'shadow', 'superman',
  'abc123', 'abc12345', '1qaz2wsx', 'q1w2e3r4', 'zaq12wsx', 'trustno1', 'hello', 'hello123',
  'contraseña', 'contrasena', 'contraseña1', 'contrasena123',
  'usuario', 'usuario1', 'usuario123', 'cliente', 'cliente123',
  'mexico', 'méxico', 'mexico123', 'mexicano', 'guadalajara', 'monterrey', 'cdmx2024', 'cdmx2025',
  'hola', 'hola123', 'hola1234', 'holamundo', 'holaqueonda',
  'bienvenido', 'bienvenida', 'bienvenido1', 'gracias', 'porfavor',
  'futbol', 'futbol123', 'beisbol', 'chivas', 'chivas123', 'america', 'america123', 'cruzazul',
  'tequila', 'mariachi', 'fiesta',
  'amor', 'amor123', 'teamo', 'teamo123', 'familia', 'familia123',
  'dios', 'dios123', 'jesus', 'jesus123', 'fenomeno',
  'changeme123', 'temppassword', 'temp1234', 'temporal', 'temporal123',
  'inicio', 'inicio123', 'sistema', 'sistema123',
])

/**
 * Devuelve { valid, reason } o { valid: true }.
 */
export function validatePassword(password) {
  if (typeof password !== 'string') {
    return { valid: false, reason: 'La contraseña debe ser texto.' }
  }
  if (password.length < MIN_LENGTH) {
    return {
      valid: false,
      reason: `La contraseña debe tener al menos ${MIN_LENGTH} caracteres.`,
    }
  }
  const normalized = password.toLowerCase().trim()
  if (COMMON_PASSWORDS.has(normalized)) {
    return {
      valid: false,
      reason: 'Esta contraseña es demasiado común. Escoge una menos predecible.',
    }
  }
  return { valid: true }
}
