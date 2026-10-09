// Relay BR para a PlayPayments.
// Recebe as chamadas do site (Cloudflare) e repassa para a PlayPayments
// SAINDO por um proxy BR (marketbet) -> a BRPix vê o IP fixo BR do proxy (liberado na whitelist).
//
// Fluxo: Site (Cloudflare) -> ESTE relay (qualquer host) -> [proxy BR marketbet] -> PlayPayments -> BRPix
//
// Variáveis de ambiente:
//   PROXY_URL    = http://usuario:senha@ip.marketbet.com.br:PORTA   (proxy BR)
//   RELAY_TOKEN  = (opcional) token compartilhado; se setado, exige header x-relay-token igual
//   PORT         = porta HTTP (padrão 8080)

const http = require('http');

const UPSTREAM = 'https://app.playpayments.com.br';
const PORT = process.env.PORT || 8080;
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const PROXY_URL = process.env.PROXY_URL || '';

// Cria o dispatcher do proxy (undici). A saída HTTPS passa a sair pelo IP do proxy BR.
let dispatcher = null;
if (PROXY_URL) {
  try {
    const { ProxyAgent } = require('undici');
    dispatcher = new ProxyAgent(PROXY_URL);
    console.log('Proxy BR ativo:', PROXY_URL.replace(/:\/\/[^@]+@/, '://***@'));
  } catch (e) {
    console.error('Falha ao criar ProxyAgent (instale "undici"):', e.message);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, relay: 'playpayments-br', proxy: !!dispatcher }));
    }

    if (!req.url.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not_found' }));
    }

    if (RELAY_TOKEN && req.headers['x-relay-token'] !== RELAY_TOKEN) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (['host', 'x-relay-token', 'content-length', 'connection', 'accept-encoding'].includes(lk)) continue;
      headers[k] = v;
    }
    headers['accept'] = headers['accept'] || 'application/json';

    const fetchOpts = {
      method: req.method,
      headers,
      body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : body
    };
    if (dispatcher) fetchOpts.dispatcher = dispatcher; // SAI pelo proxy BR

    const upstream = await fetch(UPSTREAM + req.url, fetchOpts);
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
    res.end(text);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'relay_error', message: String((e && e.message) || e) }));
  }
});

server.listen(PORT, () => console.log('Relay BR ouvindo na porta ' + PORT + (dispatcher ? ' (via proxy BR)' : ' (SEM proxy!)')));
