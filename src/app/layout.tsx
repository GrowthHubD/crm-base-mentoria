import type { Metadata } from 'next';
import './globals.css';
import { APP_DESCRIPTION, readClientName } from '@/lib/branding';
import { identidadeDaMarca } from '@/lib/marca';
import { marcaDoDeploy } from '@/lib/marca';

const FONT_STYLESHEET_URL = 'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=swap';

// `generateMetadata` e não o objeto `metadata` estático: o nome do cliente vem
// de variável de ambiente lida em RUNTIME. Com o objeto estático o Next avalia
// uma vez e congela o título no build — e como o mesmo build vai pra todos os
// Workers, todo cliente veria o nome do primeiro.
export async function generateMetadata(): Promise<Metadata> {
  // Título e favicon vestem a MARCA do deploy — "ACME - Acme" com o ícone da
  // Acme, "LIDY - Acme" com o da Lidy. Por isso os ícones são assets em
  // public/ escolhidos aqui, e não o arquivo-convenção `app/icon.png`, que é
  // um só para todos os Workers.
  const marca = identidadeDaMarca();
  const cliente = readClientName();
  const icone = marca.nome === 'Acme' ? '/logo-acme.png' : '/icon-lidy.png';
  return {
    title: cliente ? `${marca.nome.toUpperCase()} - ${cliente}` : marca.nome.toUpperCase(),
    description: APP_DESCRIPTION,
    icons: {
      icon: icone,
      apple: marca.nome === 'Acme' ? '/logo-acme.png' : '/apple-icon-lidy.png',
    },
  };
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover' as const,
};

// Define --sidebar-width antes do React montar, lendo de localStorage.
// Evita flash de layout quando a sidebar carrega no estado colapsado.
// Em viewport mobile (<768px) o sidebar vira drawer, então a var fica 0
// pra o main ocupar a tela inteira.
const SIDEBAR_WIDTH_INIT_SCRIPT = `
try {
  var isMobile = window.matchMedia && window.matchMedia('(max-width: 767px)').matches;
  if (isMobile) {
    document.documentElement.style.setProperty('--sidebar-width', '0px');
  } else {
    var c = localStorage.getItem('sidebar-collapsed');
    document.documentElement.style.setProperty('--sidebar-width', c === '1' ? '64px' : '220px');
  }
} catch (e) {
  document.documentElement.style.setProperty('--sidebar-width', '220px');
}
`.trim();

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // `data-marca` escolhe o bloco de cores em globals.css — ver lib/marca.ts.
    <html lang="pt-BR" data-marca={marcaDoDeploy()}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={FONT_STYLESHEET_URL} />
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_WIDTH_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
