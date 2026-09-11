import { redirect } from 'next/navigation';

// Rota raiz redireciona para o dashboard (ou login se não autenticado)
export default function HomePage() {
  redirect('/dashboard');
}
