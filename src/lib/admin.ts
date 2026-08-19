// Centraliza identificação do admin do Leitor Inteligente.
// Isaías (Brisacamera34@gmail.com) é o único admin com permissão de:
//   - subir livros sem pagamento
//   - publicar/despublicar ebooks
//   - aparecem automaticamente em Início/Loja (vitrine pública)
//
// Usuários comuns NÃO podem usar essas funções — o Supabase RLS + filtro
// no backend já aplicam isso de forma segura.
//
// NUNCA espalhe ADMIN_USER_ID por mais de um arquivo. Importe daqui.

export const ADMIN_EMAIL = 'Brisacamera34@gmail.com'

export const ADMIN_USER_ID = '4c347fb6-e66e-4993-b69e-93e966ef8455'

export function isAdminUser(user: { id: string; email?: string | null } | null | undefined): boolean {
  if (!user) return false
  return user.id === ADMIN_USER_ID
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return email.toLowerCase() === ADMIN_EMAIL.toLowerCase()
}
