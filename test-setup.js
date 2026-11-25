process.env.DISCORD_AGENT_IDENTITIES_JSON = JSON.stringify([
  { id: 'agent-alpha', botUserId: '1900000000000000001', tokenEnv: 'AGENT_ALPHA_DISCORD_TOKEN', apiKeyEnv: 'AGENT_ALPHA_ACTIONS_API_KEY' },
  { id: 'agent-beta', botUserId: '1900000000000000002', tokenEnv: 'AGENT_BETA_DISCORD_TOKEN', apiKeyEnv: 'AGENT_BETA_ACTIONS_API_KEY' },
  { id: 'agent-gamma', botUserId: '1900000000000000003', tokenEnv: 'AGENT_GAMMA_DISCORD_TOKEN', apiKeyEnv: 'AGENT_GAMMA_ACTIONS_API_KEY' },
]);
process.env.CLA_ROLE_ID = '1300000000000000050';
