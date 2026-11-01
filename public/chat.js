const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hora = (iso) => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

let me = null;
try { me = JSON.parse(localStorage.getItem('changuito-chat') || 'null'); } catch {}
let lastRender = '';

function render(conv) {
  // Al cliente no se le muestran las respuestas "sugeridas" (son para el operador).
  const msgs = conv.messages.filter((m) => !m.suggested);
  const html = msgs.map((m) => `<div class="msg ${m.from === 'cliente' ? 'operador' : 'cliente'}" style="align-self:${m.from === 'cliente' ? 'flex-end' : 'flex-start'};background:${m.from === 'cliente' ? '#d9fdd3' : '#fff'}">${esc(m.text)}<span class="meta">${m.from === 'operador' ? 'Equipo de envíos · ' : ''}${hora(m.at)}</span></div>`).join('');
  if (html === lastRender) return;
  lastRender = html;
  const th = $('#thread');
  th.innerHTML = html || '<div class="empty">¡Hola! Escribinos tu pedido o consulta 👋</div>';
  th.scrollTop = th.scrollHeight;
}

function show() {
  $('#intro').style.display = 'none';
  $('#thread').style.display = 'flex';
  $('#compose').style.display = 'flex';
  $('#text').focus();
}

async function poll() {
  if (!me?.conversationId) return;
  const res = await fetch(`/api/conversaciones/${me.conversationId}`);
  if (res.ok) render(await res.json());
}

$('#start').onclick = () => {
  const name = $('#name').value.trim();
  const phone = $('#phone').value.trim() || '+54 9 341 ' + Math.floor(1000000 + Math.random() * 8999999);
  me = { name, phone, conversationId: null };
  try { localStorage.setItem('changuito-chat', JSON.stringify(me)); } catch {}
  show();
  render({ messages: [] });
};

$('#compose').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#text').value.trim();
  if (!text) return;
  $('#text').value = '';
  const th = $('#thread');
  th.insertAdjacentHTML('beforeend', `<div class="msg" style="align-self:flex-end;background:#d9fdd3">${esc(text)}<span class="meta">enviando…</span></div>`);
  th.scrollTop = th.scrollHeight;
  $('#typing').style.display = 'block';
  try {
    const res = await fetch('/api/mensajes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'whatsapp', conversationId: me.conversationId, name: me.name, phone: me.phone, text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    me.conversationId = data.id;
    try { localStorage.setItem('changuito-chat', JSON.stringify(me)); } catch {}
    render(data);
  } catch (err) {
    th.insertAdjacentHTML('beforeend', `<div class="empty">No se pudo enviar: ${esc(err.message)}</div>`);
  } finally {
    $('#typing').style.display = 'none';
  }
};

if (me) { show(); poll(); }
setInterval(poll, 3000);
