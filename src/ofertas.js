// Ofertas por producto (promos tipo "oferta" de un solo producto) y productos incluidos en combos/promos.
const promociones = require('../data/promociones.json');

const oferta = new Map(); // productId → { precio, antes, promoId, titulo }
const enPromo = new Map(); // productId → [títulos de combos/promos]
for (const p of promociones) {
  if (p.tipo === 'oferta' && p.productos.length === 1 && p.precio < p.precio_antes) {
    oferta.set(p.productos[0], { precio: p.precio, antes: p.precio_antes, promoId: p.id, titulo: p.titulo });
  } else {
    for (const id of new Set(p.productos)) enPromo.set(id, [...(enPromo.get(id) || []), p.titulo]);
  }
}

const precioFinal = (p) => oferta.get(p.id)?.precio ?? p.precio;
// Prioridad: oferta directa > parte de combo/promo > nada.
const prioridad = (id) => (oferta.has(id) ? 2 : enPromo.has(id) ? 1 : 0);

module.exports = { oferta, enPromo, precioFinal, prioridad };
