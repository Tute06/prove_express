# 🛒 Changuito: mesa de pedidos con IA para envíos a domicilio

Hackatón DonWeb Day 2026, "Del problema al servidor".

## El problema
El área de envíos a domicilio de un supermercado de barrio toma pedidos **a mano**, por **WhatsApp** y por **teléfono**:
- Entre tanto trabajo hay mensajes que se pierden.
- Los pedidos se anotan mal (productos ambiguos, cantidades, sin stock, faltan la dirección o el horario).
- Los clientes esperan una respuesta y se van.

## La solución
Dos piezas que trabajan juntas:

### 1. Tienda online exclusiva para socios (`/`)
- **Login con DNI y número de socio.** Sin sesión no se ve ninguna página de la tienda.
- **Inicio:** las ofertas, combos y promociones más recientes primero, el botón para administrar el perfil (email, celular, teléfono, dirección, foto) y el botón **"Presione aquí para iniciar su compra"**.
- **Productos:**
  - arriba, los **10 más vendidos** en grande;
  - abajo, filas horizontales por **categoría**, cada una con **"Ver más"**;
  - las categorías tienen **subcategorías** de profundidad libre (Almacén › Pastas secas › Fideos).
- **Ofertas primero:** en cada categoría, en la búsqueda y en las sugerencias de la IA, los productos con oferta o promo aparecen primero, con el precio anterior tachado.
- **IA en la compra:**
  - **"Armá tu carrito con IA":** el socio escribe la lista como la mandaría por WhatsApp. La IA la convierte en productos del catálogo y marca lo que no encontró o no tiene stock, con un reemplazo propuesto. El socio revisa antes de agregar.
  - **Búsqueda asistida:** si lo que busca no existe o no tiene stock, la IA sugiere productos semejantes con stock. Prioriza las ofertas de la misma categoría.
- **Carrito y checkout:** zona, franja horaria, forma de pago, pedido mínimo y envío gratis. El pedido entra directo a la mesa de pedidos, sin anotar nada a mano.

### 2. Mesa de pedidos unificada para el equipo de envíos (`/panel.html`)
Todo mensaje entra, queda registrado y se responde en segundos:

| Dolor | Qué hace Changuito |
|---|---|
| Mensajes que se pierden | **Bandeja unificada** (WhatsApp, llamados y web). Cada mensaje se guarda *antes* de llamar a la IA. Si la IA falla, igual queda en la bandeja marcado como **"requiere humano"**. Un contador muestra cuánto espera cada cliente y alerta pasados 5 minutos. |
| Pedidos mal anotados | La IA convierte el texto libre en un **pedido estructurado** validado contra el **catálogo real**: precios y stock los calcula el servidor. Detecta ítems ambiguos, productos sin stock (y ofrece reemplazo), fuera de zona, bajo el mínimo, y datos que faltan. Antes de confirmar, muestra el resumen al cliente. |
| Clientes que esperan | **Respuesta inmediata** con información del negocio: zonas, costos de envío, horarios, medios de pago, stock. Los reclamos y cambios sobre pedidos confirmados se **derivan a un humano** con prioridad alta. |

Para los llamados, el operador pega sus notas o la transcripción y la IA arma el pedido y redacta el mensaje de confirmación para mandar por WhatsApp.

El **panel del operador** muestra la bandeja priorizada por urgencia, el detalle de cada conversación, los pedidos por estado (borrador → confirmado → preparando → en camino → entregado) y métricas en vivo: mensajes, respondidos por IA, tiempo de primera respuesta y facturación.

## Cómo usa la IA
- Modelo de OpenAI (variable `OPENAI_MODEL`) con **Structured Outputs** (JSON Schema estricto). En cada turno devuelve:
  - intención y urgencia;
  - la respuesta al cliente;
  - el pedido completo;
  - los campos faltantes;
  - si el cliente confirmó;
  - si hace falta un humano;
  - un resumen para el operador.
- El prompt está en [`prompts/agente.md`](prompts/agente.md). En cada turno recibe las reglas del negocio ([`data/negocio.json`](data/negocio.json)), el catálogo ([`data/catalogo.json`](data/catalogo.json)) y el pedido actual.
- **Defensa en profundidad**: el servidor no confía en la IA para precios, stock ni totales. Un pedido pasa a "confirmado" solo si el cliente confirmó **y** no hay problemas pendientes calculados por el servidor.
- Timeout, un reintento ante 429/5xx, y límite de mensajes por IP (la key es compartida).

## Stack
Node 22 + Express, HTML/JS sin build, persistencia en JSON (volumen de Docker), nginx como proxy y Docker Compose.

## Correrlo
```bash
cp .env.example .env   # completar OPENAI_API_KEY y HTTP_PORT
./deploy.sh            # docker compose up -d --build + chequeo de /health
```
- Tienda de socios: `http://<servidor>/`. Socio de prueba: **DNI 30111222 · socio 1001**. También DNI 28333444 · socio 1002.
- Panel del equipo de envíos: `http://<servidor>/panel.html`
- Chat del cliente (WhatsApp simulado): `http://<servidor>/chat.html`

## Próximos pasos
- Conector real con la API de WhatsApp Business.
- Transcripción automática de audios y llamados.
- Integración con el stock del sistema de caja.
- Ruteo de repartidores.
