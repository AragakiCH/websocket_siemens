// =========================================================================
// custom/navegacion/store.ts
// Qué vista está abierta en cada grupo de navegación.
//
// EL PROBLEMA QUE RESUELVE
// El Sidebar y el Screen son dos widgets independientes del lienzo. Cada uno
// se dibuja desde `render()` con SU propio `HmiWidget` y nada más: no hay
// props compartidas, ni contexto común, ni forma de que uno le hable al otro.
//
// Este módulo es ese canal. Vive fuera de React, así que los dos widgets lo
// importan y ya está — sin tocar CanvasWidget, WidgetRenderer ni el árbol de
// componentes.
//
// EL "GRUPO"
// Un lienzo puede tener más de una navegación (un menú principal arriba y
// otro de detalle en un panel, por ejemplo). El grupo mantiene cada una
// aislada de la otra. Por defecto todos usan `principal`, así que si no lo
// tocas, un Sidebar y un Screen recién soltados se enlazan solos.
//
// POR QUÉ NO SE PERSISTE
// La vista activa es estado de RUNTIME, no parte del diseño. Al abrir la
// Vista Previa siempre se empieza por la primera sección, como una web que
// abre en su portada. Lo que sí se guarda con el proyecto es a qué vista
// pertenece cada widget (`HmiWidget.vista`), que es otra cosa.
// =========================================================================
import { useSyncExternalStore } from 'react';

/** Grupo por defecto. Sidebar y Screen lo usan si no se cambia. */
export const GRUPO_POR_DEFECTO = 'principal';

/**
 * Id de vista que significa "en todas".
 *
 * Un widget con `vista` vacía se ve siempre, pase lo que pase. Es lo que
 * quieres para el propio Sidebar, para un logo o para una barra de estado:
 * cosas que acompañan a todas las pantallas.
 */
export const VISTA_TODAS = '';

/**
 * Kinds que SIEMPRE se ven, pase lo que pase.
 *
 * El propio menú y el panel de sección no pueden pertenecer a una sección: si
 * el menú desapareciera al navegar, te quedarías dentro de una sección sin
 * forma de salir. Se excluyen también del auto-asignado al soltarlos.
 */
export const KINDS_NAVEGACION = new Set<string>([
  'custom:sidebar-navegacion',
  'custom:pantalla-screen',
]);

export function esWidgetDeNavegacion(kind: string): boolean {
  return KINDS_NAVEGACION.has(kind);
}

// grupo -> id de la vista abierta
const activas = new Map<string, string>();
const oyentes = new Set<() => void>();

function avisar() {
  // Copia antes de recorrer: un oyente podría darse de baja durante el aviso
  // y modificar el Set mientras se itera.
  for (const fn of Array.from(oyentes)) fn();
}

/** Vista abierta en ese grupo. `''` si todavía no se eligió ninguna. */
export function getVistaActiva(grupo: string): string {
  return activas.get(grupo) ?? '';
}

/** Abre una vista. Es lo que hace el botón del Sidebar. */
export function setVistaActiva(grupo: string, vista: string): void {
  if (activas.get(grupo) === vista) return; // sin cambio, sin re-render
  activas.set(grupo, vista);
  avisar();
}

/**
 * Fija la vista inicial de un grupo SIN pisar la que el usuario ya eligió.
 *
 * La usa el Sidebar al montarse: sin esto, el lienzo arrancaría con todas las
 * capas ocultas y parecería vacío hasta el primer clic. Y al ser condicional,
 * un re-render no te devuelve a la portada a mitad de navegación.
 */
export function iniciarVista(grupo: string, vista: string): void {
  if (activas.has(grupo)) return;
  activas.set(grupo, vista);
  avisar();
}

/** Olvida la vista de un grupo (o de todos si no se pasa ninguno). */
export function reiniciar(grupo?: string): void {
  if (grupo === undefined) activas.clear();
  else activas.delete(grupo);
  avisar();
}

function suscribir(fn: () => void): () => void {
  oyentes.add(fn);
  return () => oyentes.delete(fn);
}

/**
 * Hook de lectura. `useSyncExternalStore` es la forma correcta en React 18
 * de leer de un store externo: React se entera del cambio sin perderse
 * actualizaciones y sin avisos de "tearing" en modo concurrente.
 */
export function useVistaActiva(grupo: string): string {
  return useSyncExternalStore(
    suscribir,
    () => getVistaActiva(grupo),
    () => getVistaActiva(grupo) // valor en servidor: el mismo, no hay SSR
  );
}

// ─── Secciones declaradas ────────────────────────────────────────
//
// El Sidebar declara las secciones; el Screen necesita saber cuáles hay para
// poder mostrar el nombre de la que está abierta. En vez de obligar a
// escribir la lista dos veces, el Sidebar la publica aquí al dibujarse.
//
// Es una caché de conveniencia, no la fuente de verdad: esa sigue siendo el
// `config.secciones` del Sidebar, que es lo que se guarda con el proyecto.

export interface Seccion {
  id: string;
  label: string;

  /**
   * `nivel` = encabezado que agrupa a las secciones que vienen debajo
   * («GENERAL», «SECADOR»). No se puede pulsar y no abre ninguna vista.
   *
   * Ausente significa `seccion`, y eso es a propósito: los menús creados
   * antes de que existieran los niveles no traen el campo y se siguen
   * leyendo tal cual, sin migrar nada.
   *
   * NIVELES Y SECCIONES VIVEN EN LA MISMA LISTA, no anidados. El menú se
   * pinta en un solo recorrido de arriba abajo, que es exactamente lo que
   * se ve en pantalla, y reordenar sigue siendo mover un elemento en una
   * lista. Anidando harían falta dos estructuras, dos editores y dos
   * formas de reordenar para el mismo resultado visual.
   */
  tipo?: 'nivel' | 'seccion';

  /**
   * Icono de la sección: el SVG en crudo, ya saneado (ver limpiarSvg()).
   *
   * Se guarda el markup y no una ruta porque así el icono viaja dentro del
   * diseño: llega a la Vista Previa y al resto de equipos sin copiar
   * ningún archivo. Un icono son unos cientos de bytes.
   */
  icono?: string;
}

/** ¿Esta entrada es un encabezado de nivel y no una sección navegable? */
export const esNivel = (s: Seccion): boolean => s.tipo === 'nivel';

/**
 * Las entradas que SÍ abren una vista.
 *
 * Lo usan el Screen y el arranque del menú: un encabezado no es un destino,
 * así que ni cuenta para «¿hay secciones?» ni puede ser la vista inicial.
 */
export const soloSecciones = (lista: Seccion[]): Seccion[] =>
  lista.filter((s) => !esNivel(s));

const seccionesPorGrupo = new Map<string, Seccion[]>();

/**
 * Lista vacía COMPARTIDA para los grupos que aún no publicaron secciones.
 *
 * Tiene que ser una constante, no un `[]` recién creado en cada llamada.
 * `useSyncExternalStore` compara el snapshot anterior con el nuevo usando
 * `Object.is`, y dos arrays vacíos distintos nunca son el mismo objeto: React
 * creería que el store cambió en cada render, volvería a dibujar, obtendría
 * otro `[]` nuevo... y así hasta "Maximum update depth exceeded".
 *
 * Congelada para que nadie le haga push por accidente y contamine a todos los
 * grupos que la comparten.
 */
const SIN_SECCIONES: Seccion[] = [];
// El freeze va aparte: `Object.freeze([])` devuelve `readonly never[]` y
// TypeScript no lo acepta como `Seccion[]` en la misma línea.
Object.freeze(SIN_SECCIONES);

export function publicarSecciones(grupo: string, secciones: Seccion[]): void {
  const previas = seccionesPorGrupo.get(grupo);
  // Comparar por contenido evita un bucle infinito de render: el Sidebar
  // publica en cada dibujo, y avisar siempre lo volvería a dibujar.
  if (previas && JSON.stringify(previas) === JSON.stringify(secciones)) return;
  seccionesPorGrupo.set(grupo, secciones);
  avisar();
}

export function getSecciones(grupo: string): Seccion[] {
  return seccionesPorGrupo.get(grupo) ?? SIN_SECCIONES;
}

export function useSecciones(grupo: string): Seccion[] {
  return useSyncExternalStore(
    suscribir,
    () => getSecciones(grupo),
    () => getSecciones(grupo)
  );
}

/** Nombre legible de una vista, para las cabeceras. */
export function etiquetaDeVista(grupo: string, vistaId: string): string {
  if (!vistaId) return '';
  return getSecciones(grupo).find((s) => s.id === vistaId)?.label ?? vistaId;
}

/**
 * ¿Este widget se ve con la vista que hay abierta?
 *
 * Las reglas, en orden:
 *   1. `vista` vacía  -> se ve SIEMPRE (el Sidebar, un logo, una barra fija)
 *   2. no hay ninguna vista abierta en su grupo -> se ve (todavía no hay
 *      navegación montada, y esconder cosas sin motivo desconcierta)
 *   3. si no, solo si su vista es la abierta
 */
export function visibleEnVista(
  vistaDelWidget: string | undefined,
  grupo: string = GRUPO_POR_DEFECTO
): boolean {
  const v = (vistaDelWidget ?? '').trim();
  if (!v) return true;
  const activa = getVistaActiva(grupo);
  if (!activa) return true;
  return v === activa;
}
