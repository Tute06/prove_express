// Integración con OpenAI: un turno del agente devuelve respuesta + pedido estructurado (JSON Schema estricto).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const negocio = require('../data/negocio.json');
const catalogo = require('../data/catalogo.json');
const ofertas = require('./ofertas');
const promptBase = fs.readFileSync(path.join(ROOT, 'prompts', 'agente.md'), 'utf8');

const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 30000);

const FALTANTES = ['items', 'direccion', 'zona', 'franja_horaria', 'forma_pago', 'nombre'];
const nullable = (type) => ({ type: [type, 'null'] });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'urgency', 'needs_human', 'needs_human_reason', 'reply', 'order', 'missing_fields', 'customer_confirmed', 'operator_summary'],
  properties: {
    intent: { type: 'string', enum: ['pedido', 'consulta', 'modificacion', 'reclamo', 'cancelacion', 'saludo', 'otro'] },
    urgency: { type: 'string', enum: ['baja', 'media', 'alta'] },
    needs_human: { type: 'boolean' },
    needs_human_reason: nullable('string'),
    reply: { type: 'string' },
    order: {
      type: 'object',
      additionalProperties: false,
      required: ['items', 'customer_name', 'address', 'zone', 'delivery_day', 'delivery_slot', 'payment_method', 'notes'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['product_id', 'raw_text', 'quantity', 'note', 'alternative_product_id'],
            properties: {
              product_id: nullable('string'),
              raw_text: { type: 'string' },
              quantity: { type: 'number' },
              note: nullable('string'),
              alternative_product_id: nullable('string'),
            },
          },
        },
        customer_name: nullable('string'),
        address: nullable('string'),
        zone: { type: ['string', 'null'], enum: [...negocio.zonas.map((z) => z.zona), null] },
        delivery_day: nullable('string'),
        delivery_slot: { type: ['string', 'null'], enum: [...negocio.franjas_horarias, null] },
        payment_method: { type: ['string', 'null'], enum: [...negocio.formas_pago, null] },
        notes: nullable('string'),
      },
    },
    missing_fields: { type: 'array', items: { type: 'string', enum: FALTANTES } },
    customer_confirmed: { type: 'boolean' },
    operator_summary: { type: 'string' },
  },
};

function catalogoTexto() {
  return catalogo
    .map((p) => {
      const o = ofertas.oferta.get(p.id);
      const promo = ofertas.enPromo.get(p.id);
      const precio = o ? `OFERTA $${o.precio} (antes $${o.antes})` : `$${p.precio}`;
      return `${p.id} | ${p.nombre} | ${precio} por ${p.unidad} | stock ${p.stock}${promo ? ` | en promo: ${promo.join(', ')}` : ''}`;
    })
    .join('\n');
}

function systemPrompt(channel, order) {
  const ahora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'full', timeStyle: 'short' });
  const base = promptBase
    .replaceAll('{{NOMBRE_NEGOCIO}}', negocio.nombre)
    .replaceAll('{{CIUDAD}}', negocio.ciudad)
    .replaceAll('{{AHORA}}', ahora);
  const pedidoActual = order
    ? JSON.stringify({
        estado: order.status,
        items: order.items.map((i) => ({ product_id: i.productId, raw_text: i.rawText, quantity: i.quantity, note: i.note, alternative_product_id: i.alternativeId })),
        customer_name: order.customer?.name || null,
        address: order.address, zone: order.zone, delivery_day: order.deliveryDay,
        delivery_slot: order.deliverySlot, payment_method: order.paymentMethod, notes: order.notes,
      })
    : 'todavía no hay pedido';
  return [
    base,
    `## NEGOCIO\n${JSON.stringify(negocio, null, 1)}`,
    `## CATÁLOGO (id | nombre | precio | stock)\n${catalogoTexto()}`,
    `## CANAL DE ESTA CONVERSACIÓN: ${channel}`,
    `## PEDIDO ACTUAL DE ESTA CONVERSACIÓN\n${pedidoActual}`,
  ].join('\n\n');
}

function historyMessages(messages) {
  // Últimos 20 mensajes; los del operador humano se pasan como del asistente, marcados.
  return messages.slice(-20).map((m) => ({
    role: m.from === 'cliente' ? 'user' : 'assistant',
    content: m.from === 'operador' ? `[Operador humano] ${m.text}` : m.text,
  }));
}

async function callOpenAI(body) {
  let lastErr;
  for (let intento = 0; intento < 2; intento++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.ok) return await res.json();
      const text = await res.text();
      lastErr = new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
      if (res.status !== 429 && res.status < 500) break; // error del pedido: no reintentar
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error(`OpenAI no respondió en ${TIMEOUT_MS / 1000} s`) : err;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw lastErr;
}

async function agentTurn({ channel, messages, order }) {
  if (!API_KEY) throw new Error('Falta OPENAI_API_KEY');
  const started = Date.now();
  const data = await callOpenAI({
    model: MODEL,
    messages: [{ role: 'system', content: systemPrompt(channel, order) }, ...historyMessages(messages)],
    response_format: { type: 'json_schema', json_schema: { name: 'turno_agente', strict: true, schema: SCHEMA } },
  });
  const choice = data.choices?.[0];
  if (choice?.message?.refusal) throw new Error(`El modelo rechazó: ${choice.message.refusal}`);
  const out = JSON.parse(choice.message.content);
  return { ...out, _meta: { model: data.model, ms: Date.now() - started, tokens: data.usage?.total_tokens ?? null } };
}

const promptLista = fs.readFileSync(path.join(ROOT, 'prompts', 'lista.md'), 'utf8');
const SCHEMA_LISTA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'items'],
  properties: {
    reply: { type: 'string' },
    items: SCHEMA.properties.order.properties.items,
  },
};

// Lista de compras en texto libre → ítems del catálogo (la tienda los muestra para revisar antes de agregar).
async function listaACarrito(text) {
  if (!API_KEY) throw new Error('La IA no está configurada (falta OPENAI_API_KEY)');
  const started = Date.now();
  const system = [
    promptLista.replaceAll('{{NOMBRE_NEGOCIO}}', negocio.nombre),
    `## CATÁLOGO (id | nombre | precio | stock)\n${catalogoTexto()}`,
  ].join('\n\n');
  const data = await callOpenAI({
    model: MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
    response_format: { type: 'json_schema', json_schema: { name: 'lista_carrito', strict: true, schema: SCHEMA_LISTA } },
  });
  const choice = data.choices?.[0];
  if (choice?.message?.refusal) throw new Error(`El modelo rechazó: ${choice.message.refusal}`);
  return { ...JSON.parse(choice.message.content), _meta: { model: data.model, ms: Date.now() - started } };
}

// Búsqueda sin resultados o sin stock → productos semejantes con stock.
const SCHEMA_SIMILARES = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'items'],
  properties: {
    reply: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['product_id', 'motivo'],
        properties: { product_id: { type: 'string', enum: catalogo.map((p) => p.id) }, motivo: { type: 'string' } },
      },
    },
  },
};

async function similares(query, sinStock) {
  if (!API_KEY) throw new Error('La IA no está configurada (falta OPENAI_API_KEY)');
  const started = Date.now();
  const system = [
    `Sos el asistente de compras de la tienda online para socios de ${negocio.nombre}. El socio buscó algo que no encontró o que no tiene stock.`,
    'Proponé hasta 6 productos del CATÁLOGO **con stock mayor a 0** que puedan reemplazar o se parezcan a lo buscado (misma función, misma categoría, otra marca o presentación).',
    'Orden: primero los que estén en OFERTA o en promo y sirvan como reemplazo dentro de la misma categoría; después el resto, del más parecido al menos parecido. Si sugerís una oferta, mencionalo en el motivo (ej. "en oferta, otra marca").',
    'Interpretá errores de tipeo y nombres coloquiales (ej. "coca" = Coca-Cola, "lavandina" = Ayudín, "fideos" = cualquier pasta seca).',
    'Si nada del catálogo sirve, devolvé `items` vacío y decilo.',
    'En `motivo` explicá en pocas palabras por qué sirve (ej. "otra marca, mismo tamaño"). En `reply`, 1 o 2 oraciones cordiales en español rioplatense.',
    `## CATÁLOGO (id | nombre | precio | stock)\n${catalogoTexto()}`,
  ].join('\n\n');
  const user = sinStock.length ? `Busqué: "${query}". Lo encontré pero sin stock: ${sinStock.join(', ')}.` : `Busqué: "${query}" y no apareció nada.`;
  const data = await callOpenAI({
    model: MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_schema', json_schema: { name: 'similares', strict: true, schema: SCHEMA_SIMILARES } },
  });
  const choice = data.choices?.[0];
  if (choice?.message?.refusal) throw new Error(`El modelo rechazó: ${choice.message.refusal}`);
  return { ...JSON.parse(choice.message.content), _meta: { model: data.model, ms: Date.now() - started } };
}

module.exports = { agentTurn, listaACarrito, similares, hasKey: () => Boolean(API_KEY), MODEL };
