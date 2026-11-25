import 'dotenv/config';
import { InstallGlobalCommands, InstallGuildCommands } from './utils.js';
import { ALL_COMMANDS } from './command-definitions.js';

// IMPORTANTE: Coloque o ID do seu servidor Discord aqui para atualização instantânea
// Para pegar o ID: Ative "Modo Desenvolvedor" no Discord → Clique com botão direito no servidor → "Copiar ID"
const GUILD_ID = process.env.GUILD_ID; // Adicione GUILD_ID no seu arquivo .env

if (GUILD_ID) {
  // Instala comandos no servidor específico (atualização instantânea)
  console.log('🔄 Instalando comandos no servidor para testes (atualização instantânea)...');
  InstallGuildCommands(process.env.APP_ID, GUILD_ID, ALL_COMMANDS);
} else {
  // Instala comandos globalmente (leva até 1 hora para atualizar)
  console.log('🌍 Instalando comandos globalmente (pode levar até 1 hora para atualizar)...');
  InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
}