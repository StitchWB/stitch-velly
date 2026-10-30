export default async function VellyBridgePlugin({ client } = {}) {
  return {
    config: async config => {
      const current = config.provider?.velly;
      const baseURL = current?.options?.baseURL;
      if (!baseURL?.startsWith('http://127.0.0.1:')) return;
      try {
        const response = await fetch(`${baseURL.replace(/\/v1\/?$/, '')}/control/provider`, {
          headers: { authorization: `Bearer ${current.options.apiKey}` },
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) throw new Error('Bridge unavailable');
        const latest = await response.json();
        if (!latest.models || !Object.keys(latest.models).length)
          throw new Error('Catalog unavailable');
        config.provider.velly = latest;
      } catch {
        await client?.app?.log?.({
          body: {
            service: 'velly',
            level: 'warn',
            message:
              'Velly bridge is unavailable or its catalog is empty. Start it in Stitch; saved model cards are retained.',
          },
        });
      }
    },
  };
}
