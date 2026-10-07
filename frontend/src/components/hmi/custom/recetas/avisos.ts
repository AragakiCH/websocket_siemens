// =========================================================================
// avisos.ts
// Las notificaciones de recetas: tarjetas en la parte de abajo de la pantalla.
//
// POR QUÉ ABAJO Y NO JUNTO AL BOTÓN
//
//   Antes cada aviso salía pegado a su widget («Hay cambios sin guardar…»
//   bajo el botón, «no tiene TAG» bajo el campo). En una pantalla con los
//   campos justo debajo de los botones, el aviso TAPABA los campos: lo que
//   avisaba escondía lo que había que mirar. Abajo y centrado no tapa nada
//   del proceso y siempre se busca en el mismo sitio.
//
// POR QUÉ ES DOM A PELO Y NO UN COMPONENTE
//
//   Lo llaman widgets sueltos (botones, campos) que no comparten ningún
//   padre donde montar un contenedor, y la Vista Previa no tiene por qué
//   saber que existen las recetas. Así basta con llamar a `notificar()`: el
//   contenedor se crea solo la primera vez, en `document.body`.
//
//   El texto entra siempre por `textContent`, nunca como HTML: lleva nombres
//   de recetas y de elementos que escribe el usuario.
// =========================================================================

export type TipoAviso = 'ok' | 'aviso' | 'error';

const COLOR: Record<TipoAviso, string> = {
  ok: '#01524f',
  aviso: '#b7791f',
  error: '#b62027',
};

// Los mismos trazos que los iconos de lucide que usa el resto de la app.
const ICONO: Record<TipoAviso, string> = {
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  aviso:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  error: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
};

const TITULO: Record<TipoAviso, string> = {
  ok: 'Listo',
  aviso: 'Atención',
  error: 'No se pudo',
};

const MAXIMO = 4;
const ID_CONTENEDOR = 'psi-avisos-receta';

interface Vivo {
  nodo: HTMLElement;
  reloj: number;
}
const vivos = new Map<string, Vivo>();

function contenedor(): HTMLElement {
  let c = document.getElementById(ID_CONTENEDOR);
  if (c) return c;
  c = document.createElement('div');
  c.id = ID_CONTENEDOR;
  c.setAttribute('aria-live', 'polite');
  Object.assign(c.style, {
    position: 'fixed',
    left: '50%',
    bottom: '22px',
    transform: 'translateX(-50%)',
    zIndex: '10000',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
    width: 'min(480px, calc(100vw - 32px))',
    pointerEvents: 'none',
    fontFamily: 'Inter, Arial, sans-serif',
  });
  document.body.appendChild(c);
  return c;
}

function quitar(clave: string): void {
  const v = vivos.get(clave);
  if (!v) return;
  vivos.delete(clave);
  window.clearTimeout(v.reloj);
  v.nodo.style.opacity = '0';
  v.nodo.style.transform = 'translateY(8px)';
  window.setTimeout(() => v.nodo.remove(), 180);
}

/**
 * Enseña una notificación abajo de la pantalla.
 *
 * El mismo mensaje repetido NO se apila: se reinicia su reloj. Pulsar tres
 * veces un botón que no puede actuar no debe llenar la pantalla de la misma
 * tarjeta.
 */
export function notificar(texto: string, tipo: TipoAviso = 'aviso', duracionMs?: number): void {
  if (typeof document === 'undefined' || !texto) return;
  // Un error o una advertencia se leen con más calma que un «listo».
  const dura = duracionMs ?? (tipo === 'ok' ? 4500 : 8000);
  const clave = `${tipo}|${texto}`;

  const previo = vivos.get(clave);
  if (previo) {
    window.clearTimeout(previo.reloj);
    previo.reloj = window.setTimeout(() => quitar(clave), dura);
    return;
  }

  // Si ya hay demasiadas, se va la más antigua.
  if (vivos.size >= MAXIMO) {
    const primera = vivos.keys().next().value;
    if (primera !== undefined) quitar(primera);
  }

  const color = COLOR[tipo];
  const nodo = document.createElement('div');
  nodo.setAttribute('role', tipo === 'ok' ? 'status' : 'alert');
  Object.assign(nodo.style, {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '11px',
    width: '100%',
    boxSizing: 'border-box',
    padding: '12px 12px 12px 14px',
    background: '#ffffff',
    color: '#263a49',
    border: '1px solid #d5dee4',
    borderLeft: `5px solid ${color}`,
    borderRadius: '9px',
    boxShadow: '0 12px 34px rgba(15,23,42,.28)',
    pointerEvents: 'auto',
    opacity: '0',
    transform: 'translateY(8px)',
    transition: 'opacity .18s ease, transform .18s ease',
  });

  const icono = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icono.setAttribute('viewBox', '0 0 24 24');
  icono.setAttribute('fill', 'none');
  icono.setAttribute('stroke', color);
  icono.setAttribute('stroke-width', '2');
  icono.setAttribute('stroke-linecap', 'round');
  icono.setAttribute('stroke-linejoin', 'round');
  Object.assign(icono.style, { width: '20px', height: '20px', flexShrink: '0', marginTop: '1px' });
  icono.innerHTML = ICONO[tipo]; // constante de este archivo, no texto del usuario

  const cuerpo = document.createElement('div');
  Object.assign(cuerpo.style, { flex: '1', minWidth: '0' });
  const titulo = document.createElement('div');
  titulo.textContent = TITULO[tipo];
  Object.assign(titulo.style, {
    fontSize: '11px',
    fontWeight: '700',
    letterSpacing: '.6px',
    textTransform: 'uppercase',
    color,
  });
  const mensaje = document.createElement('div');
  mensaje.textContent = texto;
  Object.assign(mensaje.style, {
    marginTop: '2px',
    fontSize: '13px',
    lineHeight: '1.45',
    fontWeight: '500',
    overflowWrap: 'anywhere',
  });
  cuerpo.append(titulo, mensaje);

  const cerrar = document.createElement('button');
  cerrar.type = 'button';
  cerrar.textContent = '×';
  cerrar.setAttribute('aria-label', 'Cerrar');
  Object.assign(cerrar.style, {
    flexShrink: '0',
    width: '22px',
    height: '22px',
    border: 'none',
    borderRadius: '5px',
    background: 'transparent',
    color: '#586d7c',
    fontSize: '18px',
    lineHeight: '1',
    cursor: 'pointer',
  });
  cerrar.addEventListener('click', () => quitar(clave));

  nodo.append(icono, cuerpo, cerrar);
  contenedor().appendChild(nodo);
  // En el siguiente cuadro, para que la transición de entrada se vea.
  window.requestAnimationFrame(() => {
    nodo.style.opacity = '1';
    nodo.style.transform = 'translateY(0)';
  });

  vivos.set(clave, { nodo, reloj: window.setTimeout(() => quitar(clave), dura) });
}
