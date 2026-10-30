export const verifiedModels = new Set([
  'openai/gpt-6-astra',
  'openai/gpt-6.1-sol',
  'openai/gpt-6-luna',
  'anthropic/claude-opus-5.5',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-haiku-5.5',
  'antigravity/gemini-4-argon',
  'deepseek/deepseek-v4.1-flash',
  'moonshotai/kimi-k3',
]);

// velly.one отдаёт platform-gated модели (например kimi-k3.1-pro) только с ?platform=win32 — как официальный клиент
export function catalogPath(platform) {
  return platform === 'win32' ? '/models?platform=win32' : '/models';
}

export function normalizeCatalog(raw) {
  if (!Array.isArray(raw?.models)) throw new Error('Invalid Velly catalog: expected models array');
  const seen = new Set();
  return raw.models.map(model => {
    if (
      typeof model.id !== 'string' ||
      !model.id ||
      /[\x00-\x20\x7f]/.test(model.id) ||
      model.id.startsWith('auto/') ||
      seen.has(model.id)
    )
      throw new Error('Invalid or duplicate model ID');
    seen.add(model.id);
    const protocol =
      model.agent === 'codex' ? 'responses' : model.agent === 'claude' ? 'messages' : 'chat';
    const context = Number.isSafeInteger(model.context) && model.context > 0 ? model.context : null;
    const output =
      Number.isSafeInteger(model.max_output_tokens) && model.max_output_tokens > 0
        ? model.max_output_tokens
        : null;
    return {
      id: model.id,
      name: model.name || model.id,
      protocol,
      context,
      output,
      vision: typeof model.vision === 'boolean' ? model.vision : null,
      reasoning: typeof model.reasoning === 'boolean' ? model.reasoning : null,
      price:
        Array.isArray(model.price) && model.price.every(n => Number.isFinite(n) && n >= 0)
          ? model.price
          : null,
      toolsVerified: verifiedModels.has(model.id),
      metadataSource: 'velly-catalog',
    };
  });
}

export function modelCard(model, outputLimit = 32000) {
  const npm = {
    responses: '@ai-sdk/openai',
    messages: '@ai-sdk/anthropic',
    chat: '@ai-sdk/openai-compatible',
  }[model.protocol];
  const output = Math.min(outputLimit, model.output || outputLimit, model.context - 1);
  return {
    name: model.name,
    provider: { npm },
    limit: { context: model.context, output },
    ...(model.reasoning === null
      ? {}
      : { reasoning: model.reasoning, temperature: !model.reasoning }),
    tool_call: model.toolsVerified,
    attachment: model.vision === true,
    modalities: { input: model.vision === true ? ['text', 'image'] : ['text'], output: ['text'] },
    ...(model.price?.length >= 2
      ? {
          cost: {
            input: model.price[0],
            output: model.price[1],
            ...(model.price.length > 2 ? { cache_read: model.price[2] } : {}),
          },
        }
      : {}),
    ...(model.protocol === 'responses' ? { options: { store: false } } : {}),
  };
}

export function buildProvider(models, chains, baseURL, apiKey, outputLimit = 32000) {
  const cards = Object.fromEntries(
    models
      .filter(m => m.context && m.context > outputLimit)
      .map(m => [m.id, modelCard(m, outputLimit)])
  );
  for (const [name, ids] of Object.entries(chains)) {
    const members = ids.map(id => models.find(m => m.id === id)).filter(Boolean);
    if (
      !members.length ||
      members.some(m => !m?.context || !m.toolsVerified) ||
      new Set(members.map(m => m.protocol)).size !== 1
    )
      continue;
    const context = Math.min(...members.map(m => m.context));
    if (context <= outputLimit) continue;
    const card = modelCard(
      {
        ...members[0],
        name: `Velly Auto (${name})`,
        context,
        output: Math.min(...members.map(m => m.output || outputLimit)),
        price: null,
        vision: members.every(m => m.vision === true),
        reasoning: members.every(m => m.reasoning === true),
      },
      outputLimit
    );
    cards[`auto/${name}`] = card;
  }
  return {
    npm: '@ai-sdk/anthropic',
    name: 'Velly Bridge',
    options: { baseURL, apiKey },
    models: cards,
  };
}

export const defaultChains = {
  responses: ['openai/gpt-6.1-sol', 'openai/gpt-6-astra', 'openai/gpt-6-luna'],
  messages: ['anthropic/claude-sonnet-5.5', 'deepseek/deepseek-v4.1-flash', 'moonshotai/kimi-k3'],
};
