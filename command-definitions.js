// Dice roll command for D&D
const ROLL_COMMAND = {
  name: 'rolar',
  description: 'Rolar dados para RPG de mesa',
  options: [
    {
      type: 3,
      name: 'dados',
      description: 'Notação de dados (ex: 2d6+3, 1d20, 4d8-2)',
      required: true,
    },
    {
      type: 3,
      name: 'motivo',
      description: 'Para que você está rolando?',
      required: false,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Condition lookup command
const CONDICAO_COMMAND = {
  name: 'condicao',
  description: 'Consultar condições do D&D 5e',
  options: [
    {
      type: 3,
      name: 'nome',
      description: 'Nome da condição',
      required: true,
      choices: [
        { name: 'Agarrado', value: 'agarrado' },
        { name: 'Amedrontado', value: 'amedrontado' },
        { name: 'Atordoado', value: 'atordoado' },
        { name: 'Caído', value: 'caido' },
        { name: 'Cego', value: 'cego' },
        { name: 'Enfeitiçado', value: 'enfeiticado' },
        { name: 'Envenenado', value: 'envenenado' },
        { name: 'Incapacitado', value: 'incapacitado' },
        { name: 'Inconsciente', value: 'inconsciente' },
        { name: 'Invisível', value: 'invisivel' },
        { name: 'Paralisado', value: 'paralisado' },
        { name: 'Petrificado', value: 'petrificado' },
        { name: 'Surdo', value: 'surdo' },
        { name: 'Impedido', value: 'impedido' },
      ],
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Fortnite item shop command
const LOJA_COMMAND = {
  name: 'loja',
  description: 'Mostra a loja de itens atual do Fortnite',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Fortnite player profile/stats command
const PERFIL_COMMAND = {
  name: 'perfil',
  description: 'Mostra as estatísticas de um jogador no Fortnite',
  options: [
    {
      type: 3,
      name: 'jogador',
      description: 'Nome de usuário Epic Games (ex: Clix)',
      required: true,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Fortnite map command
const MAPA_COMMAND = {
  name: 'mapa',
  description: 'Mostra o mapa atual do Fortnite com os pontos de interesse',
  options: [
    {
      type: 3,
      name: 'modo',
      description: 'Modo de jogo do mapa (padrão: Battle Royale)',
      required: false,
      // Reload revezada entre 3 mapas atualmente em rotação (Venture, Slurp
      // Rush e Elite Stronghold — confirmado em fortnite.gg); os demais ids
      // que a Osirion retorna são versões antigas/cofradas. Blitz não roda
      // em rotação — Starfall Island é o mapa atual (também via fortnite.gg).
      choices: [
        { name: 'Battle Royale', value: 'br' },
        { name: 'OG', value: 'figment' },
        { name: 'Reload: Venture', value: 'reload' },
        { name: 'Reload: Slurp Rush', value: 'reload-slurp' },
        { name: 'Reload: Elite Stronghold', value: 'reload-elitestronghold' },
        { name: 'Blitz: Starfall Island', value: 'forbiddenfruit-starfall' },
      ],
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Twitter/X tweet screenshot command
const TWITTER_COMMAND = {
  name: 'twitter',
  description: 'Gera uma imagem estilizada de um post do X/Twitter a partir do link',
  options: [
    {
      type: 3,
      name: 'link',
      description: 'Link do post (x.com ou twitter.com)',
      required: true,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Admin-only command — purges ZEN Botélia's own messages, restricted to a single
// designated channel (see CLEAR_CHANNEL_ID in app.js). default_member_permissions
// '8' = ADMINISTRATOR (1 << 3): Discord hides/blocks the command for anyone
// without that permission, independent of roles.
const CLEAR_COMMAND = {
  name: 'clear',
  description: 'Remove as mensagens do ZEN Botélia no canal designado',
  type: 1,
  default_member_permissions: '8',
  integration_types: [0],
  contexts: [0],
};

// Admin-only command — checks LLM provider health without consuming any quota.
const API_COMMAND = {
  name: 'api',
  description: 'Verifica o status das integrações de IA',
  type: 1,
  default_member_permissions: '8',
  integration_types: [0],
  contexts: [0],
};

// Free-to-play games list command (FreeToGame API)
const GRATIS_COMMAND = {
  name: 'gratis',
  description: 'Lista jogos free-to-play do FreeToGame',
  options: [
    {
      type: 3,
      name: 'categoria',
      description: 'Filtrar por categoria/gênero',
      required: false,
      choices: [
        { name: 'MMORPG', value: 'mmorpg' },
        { name: 'Shooter', value: 'shooter' },
        { name: 'Battle Royale', value: 'battle-royale' },
        { name: 'MOBA', value: 'moba' },
        { name: 'Estratégia', value: 'strategy' },
        { name: 'Esportes', value: 'sports' },
        { name: 'Corrida', value: 'racing' },
        { name: 'Luta', value: 'fighting' },
        { name: 'Sobrevivência', value: 'survival' },
        { name: 'Card Game', value: 'card' },
        { name: 'Anime', value: 'anime' },
        { name: 'Fantasia', value: 'fantasy' },
        { name: 'Sci-Fi', value: 'sci-fi' },
        { name: 'Horror', value: 'horror' },
        { name: 'Action RPG', value: 'action-rpg' },
      ],
    },
    {
      type: 3,
      name: 'plataforma',
      description: 'Filtrar por plataforma',
      required: false,
      choices: [
        { name: 'PC', value: 'pc' },
        { name: 'Navegador', value: 'browser' },
        { name: 'Todas', value: 'all' },
      ],
    },
    {
      type: 3,
      name: 'ordenar',
      description: 'Ordenar resultados',
      required: false,
      choices: [
        { name: 'Lançamento', value: 'release-date' },
        { name: 'Popularidade', value: 'popularity' },
        { name: 'A-Z', value: 'alphabetical' },
        { name: 'Relevância', value: 'relevance' },
      ],
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Public command — shows current Epic Games / Fortnite server status.
const STATUS_COMMAND = {
  name: 'status',
  description: 'Mostra o status atual dos servidores de Fortnite',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Anti-phishing lookup command (FishFish API)
const VERIFICAR_COMMAND = {
  name: 'verificar',
  description: 'Verifica se um link ou domínio está marcado como phishing/malware na base FishFish',
  options: [
    {
      type: 3,
      name: 'link',
      description: 'URL ou domínio para verificar (ex.: discord.gift ou https://exemplo.com/pagina)',
      required: true,
    },
    {
      type: 5,
      name: 'publico',
      description: 'Mostrar a resposta no canal (padrão: só você vê)',
      required: false,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

export const ALL_COMMANDS = [ROLL_COMMAND, CONDICAO_COMMAND, LOJA_COMMAND, MAPA_COMMAND, PERFIL_COMMAND, TWITTER_COMMAND, CLEAR_COMMAND, API_COMMAND, STATUS_COMMAND, GRATIS_COMMAND, VERIFICAR_COMMAND];
