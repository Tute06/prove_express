// Ofertas por producto (promos tipo "oferta" de un solo producto) y productos incluidos en combos/promos.
const db = require('./db');

function mapas() {
  const oferta = new Map(); // productId → { precio, antes, promoId, titulo }
  const enPromo = new Map(); // productId → [títulos de combos/promos]
  for (const p of db.promociones()) {
    const unico = p.productos.length === 1 && p.productos[0].cantidad === 1;
    if (p.tipo === 'oferta' && unico && p.precio < p.precio_antes) {
      oferta.set(p.productos[0].id, { precio: p.precio, antes: p.precio_antes, promoId: p.id, titulo: p.titulo });
    } else {
      for (const { id } of p.productos) enPromo.set(id, [...(enPromo.get(id) || []), p.titulo]);
    }
  }
  return { oferta, enPromo };
}

const precioFinal = (p, m = mapas()) => m.oferta.get(p.id)?.precio ?? p.precio;
// Prioridad: oferta directa > parte de combo/promo > nada.
const prioridad = (id, m = mapas()) => (m.oferta.has(id) ? 2 : m.enPromo.has(id) ? 1 : 0);

module.exports = { mapas, precioFinal, prioridad };
