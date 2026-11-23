const element = id => document.getElementById(id);
const form = element('form');
const submit = element('submit');
const status = element('status');
const timeZone = 'America/Sao_Paulo';

function showStatus(message, error = false) {
  status.textContent = message;
  status.className = 'status ' + (error ? 'err' : 'ok');
  status.style.display = 'block';
}

async function checkout(query = '', options) {
  const response = await fetch('/api/checkout' + query, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

async function loadEvent() {
  const event = await checkout();
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone, day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit'
  });
  const date = Object.fromEntries(formatter.formatToParts(new Date(event.startsAt)).map(p => [p.type, p.value]));
  document.querySelector('.datebig').textContent = date.day;
  document.querySelector('.datetxt').textContent = 'DE ' + date.month.toUpperCase();
  element('start').textContent = 'Primeira bateria às ' + date.hour + 'h' + date.minute;
  element('price').textContent = new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL'
  }).format(event.priceCents / 100);
  element('count').textContent = event.confirmed;
  element('spots').textContent = event.available;
  element('bar').style.width = (event.confirmed / 60 * 100) + '%';
  if (!event.available || new Date(event.startsAt) <= new Date()) {
    submit.disabled = true;
    showStatus('Inscrições indisponíveis no momento.');
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  submit.disabled = true;
  const entry = {
    team: element('team').value,
    athlete1: element('a1').value,
    athlete2: element('a2').value,
    whatsapp1: element('w1').value,
    whatsapp2: element('w2').value,
    category: new FormData(form).get('level'),
  };
  try {
    const result = await checkout('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    location.assign(result.url);
  } catch (error) {
    submit.disabled = false;
    showStatus(error.message, true);
  }
});

async function checkPayment(id) {
  try {
    const entry = await checkout('?id=' + encodeURIComponent(id));
    if (entry.status === 'Confirmada') {
      const time = new Intl.DateTimeFormat('pt-BR', {
        timeZone, dateStyle: 'short', timeStyle: 'short'
      }).format(new Date(entry.startsAt));
      showStatus('Inscrição confirmada. Bateria ' + entry.heat + ' • ' + time);
      return;
    }
    if (entry.status === 'Pendente') {
      showStatus('Aguardando a confirmação do Mercado Pago. Esta página atualiza automaticamente.');
      setTimeout(() => checkPayment(id), 15000);
      return;
    }
    if (entry.status === 'Expirada') {
      form.hidden = false;
      showStatus('O prazo de pagamento terminou. Você pode iniciar outra inscrição.', true);
      return;
    }
    showStatus('Situação da inscrição: ' + entry.status + '. Entre em contato com a organização.');
  } catch (error) {
    showStatus(error.message + ' Consultaremos novamente em instantes.', true);
    setTimeout(() => checkPayment(id), 15000);
  }
}

const entryId = new URLSearchParams(location.search).get('inscricao');
loadEvent().catch(error => showStatus(error.message, true)).then(() => {
  if (entryId && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(entryId)) {
    form.hidden = true;
    checkPayment(entryId);
  }
});
