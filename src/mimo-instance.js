// src/mimo-instance.js
import { exec } from 'child_process';
import { promisify } from 'util';
import { accountDB } from './database.js';
import { config } from './config.js';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);

// Cria o diretório de perfis se não existir
const profilesDir = path.join(path.dirname(config.dbPath), 'mimo-profiles');
if (!fs.existsSync(profilesDir)) {
  fs.mkdirSync(profilesDir, { recursive: true });
}

// Portas disponíveis para instâncias do `mimo serve`
let nextPort = 4096;

export async function startMimoInstance(account) {
  // Gera um ID de sessão único
  const sessionId = `mimo-session-${account.id}-${Date.now()}`;

  // Define a porta para esta instância
  const port = nextPort++;
  if (nextPort > 5000) nextPort = 4096; // Reutiliza portas

  // Caminho para o perfil desta conta
  const profilePath = path.join(profilesDir, `account-${account.id}`);

  // Comando para iniciar o `mimo serve` com autenticação
  // NOTA: O MiMo Code pode não ter opção de autenticação por linha de comando.
  // Se não tiver, você precisará usar automação com Playwright (veja alternativa abaixo)
  const command = `mimo serve --port ${port} --profile ${profilePath}`;

  console.log(`[MimoInstance] Iniciando instância para ${account.email} na porta ${port}`);

  try {
    // Inicia o processo
    const child = exec(command, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MIMO_EMAIL: account.email,
        MIMO_PASSWORD: account.password,
      },
    });

    // Aguarda um pouco para a instância subir
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verifica se a instância está respondendo
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      method: 'GET',
      timeout: 5000,
    });

    if (response.ok) {
      console.log(`[MimoInstance] Instância ${sessionId} pronta na porta ${port}`);
      return {
        sessionId,
        port,
        pid: child.pid,
        accountId: account.id,
        url: `http://127.0.0.1:${port}`,
      };
    } else {
      throw new Error('Instância não respondeu ao health check');
    }
  } catch (error) {
    console.error(`[MimoInstance] Falha ao iniciar instância: ${error.message}`);
    return null;
  }
}
async function checkMimoHealth(url) {
  try {
    const response = await fetch(`${url}/healthz`, { timeout: 5000 });
    return response.ok;
  } catch (error) {
    return false;
  }
}

import { chromium } from 'playwright';

// Alternativa: Se o `mimo serve` não aceita autenticação por linha de comando,
// você pode usar Playwright para fazer login automático:
export async function startMimoInstanceWithPlaywright(account) {
  const profilePath = path.join(profilesDir, `account-${account.id}`);
  if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });
  const sessionId = `mimo-session-${account.id}-${Date.now()}`;
  const context = await chromium.launchPersistentContext(profilePath, { headless: false });
  const page = context.pages()[0] || await context.newPage();

  // Faz login no Mistral
  await page.goto('https://chat.mistral.ai/');

  // Se já logado, pula login (verifica se o campo de input do chat está visível)
  if (await page.locator('div.ProseMirror[contenteditable="true"]').first().isVisible().catch(() => false)) {
    return { sessionId, browser: context, context, page };
  }
  
  // 1. Clica no botão "Aceitar e continuar" (termos)
  const acceptTermsBtn = page.locator('button:has-text("Aceitar e continuar")');
  if (await acceptTermsBtn.isVisible().catch(() => false)) {
    await acceptTermsBtn.click();
    await page.waitForTimeout(500);
  }

  // 2. Clica no botão "Entrar"
  const signInBtn = page.locator('button:has-text("Entrar")');
  if (await signInBtn.isVisible().catch(() => false)) {
    await signInBtn.click();
    await page.waitForTimeout(1000);
  }

  // 3. Preenche email
  const emailInput = page.locator('input[name="email"], input[type="email"][placeholder="you@example.com"]');
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill(account.email);
    await page.waitForTimeout(500);
  }

  // 4. Clica no botão "Continuar" abaixo do email
  const continueEmailBtn = page.locator('button[type="submit"]:has-text("Continuar")');
  if (await continueEmailBtn.isVisible().catch(() => false)) {
    await continueEmailBtn.click();
    await page.waitForTimeout(1500);
  }

  // 5. Preenche senha
  const passwordInput = page.locator('input[name="password"], input[type="password"][autocomplete="current-password"]');
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill(account.password);
    await page.waitForTimeout(500);
  }

  // 6. Clica no botão "Continuar com senha"
  const continuePasswordBtn = page.locator('button[type="submit"]:has-text("Continuar com senha")');
  if (await continuePasswordBtn.isVisible().catch(() => false)) {
    await continuePasswordBtn.click();
  }

  // 7. Aguarda o campo de chat aparecer (verificação de sucesso)
  await page.waitForSelector('div.ProseMirror[contenteditable="true"]', { timeout: 0 });

  // Extrair tokens de autenticação do localStorage (Mistral pode usar tokens em vez de apenas cookies)
  const authData = await page.evaluate(() => {
    const tokens = {};
    // Verifica localStorage por tokens de auth
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.includes('auth') || key.includes('token') || key.includes('session') || key.includes('access'))) {
        tokens[key] = localStorage.getItem(key);
      }
    }
    // Também verifica sessionStorage
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && (key.includes('auth') || key.includes('token') || key.includes('session') || key.includes('access'))) {
        tokens[key] = sessionStorage.getItem(key);
      }
    }
    return tokens;
  });

  const cookies = await context.cookies();

  return { sessionId, browser: context, context, page, authData, cookies };
}