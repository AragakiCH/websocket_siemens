// =========================================================================
// utils/preferenciasNavegador.ts
// Lo que este navegador guarda en localStorage y ES configuración, para que
// viaje en la copia de seguridad y vuelva al restaurar.
//
// QUÉ ENTRA Y QUÉ NO
// Entra lo que uno rehace a mano si se pierde: qué variables están marcadas
// en Configuración, el lienzo de Flujos, el modo de color, la base elegida
// para cuentas/alarmas/recetas, el último proyecto y pantalla abiertos, las
// categorías plegadas. NO entran el token de sesión (es de este navegador y
// de esta sesión), las cachés (se regeneran) ni los borradores a medias.
// =========================================================================

/** Claves exactas que viajan. */
const CLAVES = [
  'hmi.plc.selection',
  'srx_flow_editor',
  'hmi.modo-color',
  'hmi.auth.db',
  'hmi.alarmas.db',
  'hmi.recetas.db',
  'hmi.proyecto.ultimo',
  'psi.hmi.categorias-plegadas',
];
/** Prefijos: una clave por pantalla/proyecto. */
const PREFIJOS = ['hmi.design.ultima'];

function esConfiguracion(clave: string): boolean {
  if (clave.toLowerCase().includes('token')) return false;
  return CLAVES.includes(clave) || PREFIJOS.some((p) => clave.startsWith(p));
}

/** `{clave: valor}` con lo que hay ahora en este navegador. */
export function leerPreferenciasNavegador(): Record<string, string> {
  const salida: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !esConfiguracion(k)) continue;
      const v = localStorage.getItem(k);
      if (v !== null) salida[k] = v;
    }
  } catch {
    /* sin storage */
  }
  return salida;
}

/**
 * Aplica lo que trajo una copia. Solo claves de configuración (lo demás se
 * ignora aunque venga), y solo las que CAMBIAN. Devuelve cuántas cambió.
 */
export function aplicarPreferenciasNavegador(prefs: Record<string, string>): number {
  let n = 0;
  try {
    for (const [k, v] of Object.entries(prefs)) {
      if (typeof v !== 'string' || !esConfiguracion(k)) continue;
      if (localStorage.getItem(k) === v) continue;
      localStorage.setItem(k, v);
      n += 1;
    }
  } catch {
    /* sin storage */
  }
  return n;
}
